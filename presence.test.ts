import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
    renderPresence, formatUptime, StatusStore, projectName, findAbandoned,
    readBeat, writeBeat, beatHealth, beatFile, pidAlive,
} from './presence.js'

const tempDir = (tag: string) => fs.mkdtempSync(path.join(os.tmpdir(), `presence-${tag}-`))

test('formatUptime', () => {
    assert.equal(formatUptime(34_000), '34s')
    assert.equal(formatUptime(51 * 60_000), '51m')
    assert.equal(formatUptime(125 * 60_000), '2h 05m')
    assert.equal(formatUptime(-10), '0s')
})

test('renderPresence', async (t) => {
    const since = new Date('2026-09-12T23:24:00').getTime()

    await t.test('says it is connected, and how to reach it', () => {
        const text = renderPresence({ project: 'your-project', online: true, since })
        assert.match(text, /^🟢 \*Claude is connected\* · your-project/)
        assert.match(text, /23:24/)
        assert.match(text, /@mention me/)
    })

    await t.test('says it is offline, and for how long it was not', () => {
        // The point of the offline line: a quiet channel and a dead one look
        // identical otherwise.
        const text = renderPresence({
            project: 'your-project', online: false, since,
            until: since + 51 * 60_000,
        })
        assert.match(text, /^⚪ \*Claude is offline\*/)
        assert.match(text, /23:24–00:15/)
        assert.match(text, /51m/)
        assert.match(text, /Nothing is listening/)
    })

    await t.test('amber when connected but nothing is listening', () => {
        // The failure this whole project keeps hitting: outbound works, the
        // channel looks alive, and every message written here sits unread.
        // Saying "connected" in that state is a lie of omission.
        const text = renderPresence({ project: 'p', online: true, listening: false, since })
        assert.match(text, /^🟡 \*Claude is connected but not listening\*/)
        assert.match(text, /wait unread/)
        assert.doesNotMatch(text, /🟢/)
    })

    await t.test('green when it is listening, and when nothing said otherwise', () => {
        assert.match(renderPresence({ project: 'p', online: true, listening: true, since }), /^🟢/)
        assert.match(renderPresence({ project: 'p', online: true, since }), /^🟢/)
    })

    await t.test('offline beats not-listening', () => {
        // A stopped server is not "connected but deaf", it is gone.
        const text = renderPresence({ project: 'p', online: false, listening: false, since, until: since + 1000 })
        assert.match(text, /^⚪/)
    })

    await t.test('drops the separator when there is no project name', () => {
        const text = renderPresence({ project: '', online: true, since })
        assert.match(text, /^🟢 \*Claude is connected\*\n/)
    })

    await t.test('falls back to now when an offline line has no end', () => {
        const text = renderPresence({ project: 'p', online: false, since }, since + 60_000)
        assert.match(text, /1m/)
    })
})

test('StatusStore', async (t) => {
    await t.test('remembers the message across a restart', () => {
        // The whole point: an in-memory timestamp would post a new status
        // message on every start, which is what this exists to avoid.
        const dir = tempDir('roundtrip')
        new StatusStore(dir, 'C0AAA').write({ ts: '1789.001', online: true, since: 5 })
        assert.deepEqual(new StatusStore(dir, 'C0AAA').read(),
            { ts: '1789.001', online: true, since: 5 })
    })

    await t.test('reads null before anything is written', () => {
        assert.equal(new StatusStore(tempDir('empty'), 'C0AAA').read(), null)
    })

    await t.test('keeps two channels apart', () => {
        const dir = tempDir('two')
        new StatusStore(dir, 'C0AAA').write({ ts: '1.1', online: true, since: 1 })
        new StatusStore(dir, 'C0BBB').write({ ts: '2.2', online: false, since: 2 })
        assert.equal(new StatusStore(dir, 'C0AAA').read()?.ts, '1.1')
        assert.equal(new StatusStore(dir, 'C0BBB').read()?.ts, '2.2')
    })

    await t.test('a corrupt file reads as nothing rather than throwing', () => {
        // It would otherwise take down startup, which is a bad trade for a
        // decorative line in a channel.
        const dir = tempDir('corrupt')
        const store = new StatusStore(dir, 'C0AAA')
        fs.writeFileSync(store.file, 'not json at all')
        assert.equal(store.read(), null)
    })

    await t.test('clear forgets the message', () => {
        const dir = tempDir('clear')
        const store = new StatusStore(dir, 'C0AAA')
        store.write({ ts: '1.1', online: true, since: 1 })
        store.clear()
        assert.equal(store.read(), null)
    })

    await t.test('the channel is sanitised before it reaches the filesystem', () => {
        const dir = tempDir('nasty')
        const store = new StatusStore(dir, '../../etc/passwd')
        assert.equal(path.dirname(store.file), dir)
        assert.doesNotMatch(path.basename(store.file), /[\/.]{2}/)
    })
})

test('findAbandoned', async (t) => {
    const NOW = 1_000_000

    /** A channel with a status line, and optionally a heartbeat beside it. */
    function channel(dir: string, id: string, opts: { online: boolean, beatAt?: number }) {
        fs.writeFileSync(path.join(dir, `slack-status-${id}.json`),
            JSON.stringify({ ts: `ts-${id}`, online: opts.online, since: NOW - 60_000 }))
        if (opts.beatAt !== undefined) {
            fs.writeFileSync(path.join(dir, `slack-alive-${id}.json`),
                JSON.stringify({ pid: 1, channel: id, at: opts.beatAt }))
        }
    }

    await t.test('finds a channel whose server stopped beating', () => {
        // The force-kill case: no shutdown handler ran, so the line still says
        // connected and nothing has corrected it.
        const dir = tempDir('stale')
        channel(dir, 'C0DEAD', { online: true, beatAt: NOW - 300_000 })

        const found = findAbandoned(dir, { now: NOW })
        assert.equal(found.length, 1)
        assert.equal(found[0].channel, 'C0DEAD')
        assert.equal(found[0].status.ts, 'ts-C0DEAD')
    })

    await t.test('leaves a live server alone', () => {
        const dir = tempDir('live')
        channel(dir, 'C0LIVE', { online: true, beatAt: NOW - 5_000 })
        assert.deepEqual(findAbandoned(dir, { now: NOW }), [])
    })

    await t.test('a status file with no heartbeat at all counts as abandoned', () => {
        // Only a version that writes heartbeats writes status files, so the
        // absence means the server is gone, not that it is an old build.
        const dir = tempDir('noheart')
        channel(dir, 'C0GONE', { online: true })
        assert.equal(findAbandoned(dir, { now: NOW }).length, 1)
    })

    await t.test('ignores a line already marked offline', () => {
        // Otherwise every sweep rewrites the same message forever.
        const dir = tempDir('already')
        channel(dir, 'C0DONE', { online: false, beatAt: NOW - 300_000 })
        assert.deepEqual(findAbandoned(dir, { now: NOW }), [])
    })

    await t.test('skips our own channel', () => {
        // This server is alive by definition; its own line is its own business.
        const dir = tempDir('self')
        channel(dir, 'C0SELF', { online: true, beatAt: NOW - 300_000 })
        assert.deepEqual(findAbandoned(dir, { now: NOW, skip: 'C0SELF' }), [])
    })

    await t.test('sorts nothing else in the directory into the result', () => {
        const dir = tempDir('noise')
        fs.writeFileSync(path.join(dir, 'slack-inbox-C0AAA.jsonl'), '{}\n')
        fs.writeFileSync(path.join(dir, 'slack-debug.log'), 'hello')
        fs.writeFileSync(path.join(dir, 'slack-status.json'), '{"ts":"x","online":true}')
        assert.deepEqual(findAbandoned(dir, { now: NOW }), [])
    })

    await t.test('a directory that is not there is not an error', () => {
        assert.deepEqual(findAbandoned(path.join(os.tmpdir(), 'no-such-dir-xyz'), { now: NOW }), [])
    })
})

test('projectName', async (t) => {
    await t.test('uses the working directory, which is the project', () => {
        assert.equal(projectName({}, '/path/to/your-project'), 'your-project')
    })

    await t.test('an explicit name wins', () => {
        assert.equal(projectName({ SLACK_PROJECT_NAME: 'Two-Factor' }, '/path/to/your-project'), 'Two-Factor')
    })

    await t.test('the server\'s own directory is not a project', () => {
        // What you get when it was launched by hand rather than by a session.
        assert.equal(projectName({}, '/opt/Claude-Code-Slack-Channel'), '')
    })

    await t.test('ignores a blank override', () => {
        assert.equal(projectName({ SLACK_PROJECT_NAME: '   ' }, '/x/Widgets'), 'Widgets')
    })
})

test('heartbeats', async (t) => {
    const NOW = 1_000_000

    await t.test('round-trips through a file', () => {
        const dir = tempDir('beat')
        writeBeat(dir, 'watcher', 'C0AAA', 4242)
        const beat = readBeat(dir, 'watcher', 'C0AAA')
        assert.equal(beat?.pid, 4242)
        assert.equal(beat?.channel, 'C0AAA')
    })

    await t.test('server and watcher do not share a file', () => {
        // They answer different questions: is anything connected, and is
        // anything listening. Conflating them hides the second.
        const dir = tempDir('kinds')
        writeBeat(dir, 'server', 'C0AAA', 1)
        writeBeat(dir, 'watcher', 'C0AAA', 2)
        assert.equal(readBeat(dir, 'server', 'C0AAA')?.pid, 1)
        assert.equal(readBeat(dir, 'watcher', 'C0AAA')?.pid, 2)
    })

    await t.test('a fresh beat from a live process reads as running', () => {
        const health = beatHealth({ pid: 7, at: NOW - 5_000 }, { now: NOW, isAlive: () => true })
        assert.equal(health.alive, true)
        assert.match(health.detail, /pid 7/)
    })

    await t.test('a fresh beat from a DEAD process is not running', () => {
        // The bug this exists for: slack_status reported
        //   Watcher: RUNNING - pid 38296
        // for a process that no longer existed. It had died inside the
        // staleness window, so the file had not aged out yet. A diagnostic
        // that reports the last thing it was told is worse than none, because
        // it gets believed -- and this is the one tool meant to catch exactly
        // this failure.
        const health = beatHealth({ pid: 38296, at: NOW - 5_000 }, { now: NOW, isAlive: () => false })
        assert.equal(health.alive, false)
        assert.match(health.detail, /38296/)
        assert.match(health.detail, /not running/)
    })

    await t.test('staleness still wins without consulting the process table', () => {
        // An old beat is stopped regardless; a recycled pid must not resurrect it.
        const health = beatHealth({ pid: 7, at: NOW - 600_000 }, { now: NOW, isAlive: () => true })
        assert.equal(health.alive, false)
        assert.match(health.detail, /stopped/)
    })

    await t.test('a stale beat reads as stopped, and says how long ago', () => {
        const health = beatHealth({ pid: 7, at: NOW - 600_000 }, { now: NOW })
        assert.equal(health.alive, false)
        assert.match(health.detail, /10m ago/)
        assert.match(health.detail, /stopped/)
    })

    await t.test('a missing beat reads as not running, not as an error', () => {
        // The commonest real state: the watcher was never started.
        const health = beatHealth(readBeat(tempDir('none'), 'watcher', 'C0AAA'), { now: NOW })
        assert.equal(health.alive, false)
        assert.equal(health.detail, 'not running')
    })

    await t.test('a half-written beat reads as missing rather than throwing', () => {
        const dir = tempDir('torn')
        fs.writeFileSync(beatFile(dir, 'server', 'C0AAA'), '{"pid":1,"at"')
        assert.equal(readBeat(dir, 'server', 'C0AAA'), null)
    })
})

test('pidAlive', async (t) => {
    await t.test('this process is alive', () => {
        assert.equal(pidAlive(process.pid), true)
    })

    await t.test('a pid that cannot exist is not', () => {
        assert.equal(pidAlive(0), false)
        assert.equal(pidAlive(-1), false)
        // Above the typical pid_max on every platform this runs on.
        assert.equal(pidAlive(0x7ffffff0), false)
    })
})
