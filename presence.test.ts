import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { renderPresence, formatUptime, StatusStore, projectName } from './presence.js'

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
        const text = renderPresence({ project: '2FA_app', online: true, since })
        assert.match(text, /^🟢 \*Claude is connected\* · 2FA_app/)
        assert.match(text, /23:24/)
        assert.match(text, /@mention me/)
    })

    await t.test('says it is offline, and for how long it was not', () => {
        // The point of the offline line: a quiet channel and a dead one look
        // identical otherwise.
        const text = renderPresence({
            project: '2FA_app', online: false, since,
            until: since + 51 * 60_000,
        })
        assert.match(text, /^⚪ \*Claude is offline\*/)
        assert.match(text, /23:24–00:15/)
        assert.match(text, /51m/)
        assert.match(text, /Nothing is listening/)
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
        new StatusStore(dir, 'C0AAA').write('1789.001')
        assert.equal(new StatusStore(dir, 'C0AAA').read(), '1789.001')
    })

    await t.test('reads empty before anything is written', () => {
        assert.equal(new StatusStore(tempDir('empty'), 'C0AAA').read(), '')
    })

    await t.test('keeps two channels apart', () => {
        const dir = tempDir('two')
        new StatusStore(dir, 'C0AAA').write('1.1')
        new StatusStore(dir, 'C0BBB').write('2.2')
        assert.equal(new StatusStore(dir, 'C0AAA').read(), '1.1')
        assert.equal(new StatusStore(dir, 'C0BBB').read(), '2.2')
    })

    await t.test('a corrupt file reads as empty rather than throwing', () => {
        // It would otherwise take down startup, which is a bad trade for a
        // decorative line in a channel.
        const dir = tempDir('corrupt')
        const store = new StatusStore(dir, 'C0AAA')
        fs.writeFileSync(store.file, 'not json at all')
        assert.equal(store.read(), '')
    })

    await t.test('clear forgets the message', () => {
        const dir = tempDir('clear')
        const store = new StatusStore(dir, 'C0AAA')
        store.write('1.1')
        store.clear()
        assert.equal(store.read(), '')
    })

    await t.test('the channel is sanitised before it reaches the filesystem', () => {
        const dir = tempDir('nasty')
        const store = new StatusStore(dir, '../../etc/passwd')
        assert.equal(path.dirname(store.file), dir)
        assert.doesNotMatch(path.basename(store.file), /[\\/.]{2}/)
    })
})

test('projectName', async (t) => {
    await t.test('uses the working directory, which is the project', () => {
        assert.equal(projectName({}, 'E:/yas_apps/2FA_app'), '2FA_app')
    })

    await t.test('an explicit name wins', () => {
        assert.equal(projectName({ SLACK_PROJECT_NAME: 'Two-Factor' }, 'E:/yas_apps/2FA_app'), 'Two-Factor')
    })

    await t.test('the server\'s own directory is not a project', () => {
        // What you get when it was launched by hand rather than by a session.
        assert.equal(projectName({}, 'D:/MCP-tools/Claude-Code-Slack-Channel'), '')
    })

    await t.test('ignores a blank override', () => {
        assert.equal(projectName({ SLACK_PROJECT_NAME: '   ' }, 'E:/x/Radars'), 'Radars')
    })
})
