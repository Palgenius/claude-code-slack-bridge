import test from 'node:test'
import assert from 'node:assert/strict'

import {
    TurnTracker, renderTurn, toolTarget, shortToolName,
    formatDuration, formatTokens, ACTIVITY_ROWS, worthShowing, TRIVIAL_MS, type Turn,
} from './turn.js'

let clock = 1_700_000_000_000
const at = (seconds: number) => new Date(clock + seconds * 1000).toISOString()

/** A user prompt: content as a plain string is what makes it a turn start. */
const prompt = (uuid: string, seconds = 0) => ({
    type: 'user', uuid, timestamp: at(seconds),
    message: { role: 'user', content: 'do the thing' },
})

/** Tool results come back as a user entry holding an array. */
const results = (seconds: number, isError = false) => ({
    type: 'user', uuid: `r${seconds}`, timestamp: at(seconds),
    message: { role: 'user', content: [{ type: 'tool_result', is_error: isError || undefined }] },
})

const assistant = (uuid: string, content: any[], opts: {
    seconds?: number, stop?: string, tokens?: number, sidechain?: boolean,
} = {}) => ({
    type: 'assistant', uuid, timestamp: at(opts.seconds ?? 0),
    isSidechain: opts.sidechain,
    message: {
        role: 'assistant', content,
        stop_reason: opts.stop ?? 'tool_use',
        usage: { output_tokens: opts.tokens ?? 0 },
    },
})

const use = (id: string, name: string, input: any = {}) =>
    ({ type: 'tool_use', id, name, input })

test('shortToolName', async (t) => {
    await t.test('leaves an ordinary tool alone', () => {
        assert.equal(shortToolName('Bash'), 'Bash')
    })

    await t.test('shortens an mcp tool to the part that means something', () => {
        assert.equal(shortToolName('mcp__ccd_session__mark_chapter'), 'mark_chapter')
    })
})

test('toolTarget', async (t) => {
    await t.test('prefers the written description over anything derived', () => {
        // Bash carries a one-line human summary, which is both more readable
        // than the command and means the command is never looked at.
        assert.equal(
            toolTarget({ command: 'rm -rf build && npm run deploy', description: 'Rebuild and deploy' }),
            'Rebuild and deploy')
    })

    await t.test('falls back to the file, as a basename only', () => {
        // A full path says more about the machine than is useful in a channel.
        assert.equal(toolTarget({ file_path: '/repo/src/auth.ts' }), 'auth.ts')
    })

    await t.test('uses a search pattern when there is nothing better', () => {
        assert.equal(toolTarget({ pattern: 'thread_ts' }), 'thread_ts')
    })

    await t.test('never returns file content', () => {
        const target = toolTarget({ file_path: 'a.ts', content: 'const apiKey = "live"' })
        assert.equal(target, 'a.ts')
    })

    await t.test('redacts a secret that made it into a path or description', () => {
        const target = toolTarget({ description: 'curl with token=abcd1234efgh' })
        assert.match(target as string, /\[redacted\]/)
        assert.doesNotMatch(target as string, /abcd1234efgh/)
    })

    await t.test('truncates something long', () => {
        const target = toolTarget({ description: 'x'.repeat(200) }) as string
        assert.ok(target.length <= 72, `got ${target.length}`)
        assert.match(target, /…$/)
    })

    await t.test('says nothing when there is nothing safe to say', () => {
        assert.equal(toolTarget({ old_string: 'a', new_string: 'b' }), undefined)
        assert.equal(toolTarget(undefined), undefined)
        assert.equal(toolTarget('a string'), undefined)
    })
})

test('TurnTracker', async (t) => {
    await t.test('a prompt starts a turn, end_turn finishes it', () => {
        const tracker = new TurnTracker('name')
        const kinds = tracker.feed([
            prompt('u1'),
            assistant('a1', [use('t1', 'Bash')], { seconds: 1 }),
            results(2),
            assistant('a2', [{ type: 'text', text: 'done' }], { seconds: 3, stop: 'end_turn' }),
        ]).map((e) => e.kind)

        assert.deepEqual(kinds, ['start', 'activity', 'text', 'end'])
    })

    await t.test('tool results are not a new turn', () => {
        // They arrive as user entries too; only a string content is a person.
        const tracker = new TurnTracker('name')
        const starts = tracker.feed([prompt('u1'), results(1), results(2)])
            .filter((e) => e.kind === 'start')
        assert.equal(starts.length, 1)
    })

    await t.test('never emits thinking', () => {
        // Private reasoning has no path to the channel, by construction.
        const tracker = new TurnTracker('name')
        const events = tracker.feed([
            prompt('u1'),
            assistant('a1', [
                { type: 'thinking', thinking: 'the user probably means X' },
                { type: 'text', text: 'here is the answer' },
            ], { seconds: 1 }),
        ])
        const texts = events.filter((e) => e.kind === 'text').map((e: any) => e.text)
        assert.deepEqual(texts, ['here is the answer'])
    })

    await t.test('redacts prose on the way out', () => {
        const tracker = new TurnTracker('name')
        const events = tracker.feed([
            prompt('u1'),
            assistant('a1', [{ type: 'text', text: 'the config said password=hunter2swordfish' }]),
        ])
        const text = (events.find((e) => e.kind === 'text') as any).text
        assert.match(text, /\[redacted\]/)
        assert.doesNotMatch(text, /hunter2swordfish/)
    })

    await t.test('ignores a subagent transcript', () => {
        // Its work shows up in the parent as the Task call that started it,
        // which is the level worth watching.
        const tracker = new TurnTracker('name')
        const events = tracker.feed([
            prompt('u1'),
            assistant('s1', [use('t9', 'Read')], { sidechain: true }),
        ])
        assert.deepEqual(events.map((e) => e.kind), ['start'])
        assert.equal(tracker.current?.tools, 0)
    })

    await t.test('re-reading the same entries changes nothing', () => {
        // The tailer re-reads a line that was half-written when it last looked.
        const tracker = new TurnTracker('name')
        const entries = [prompt('u1'), assistant('a1', [use('t1', 'Edit', { file_path: 'a.ts' })])]
        tracker.feed(entries)
        const again = tracker.feed(entries.slice(1))

        assert.deepEqual(again, [])
        assert.equal(tracker.current?.tools, 1)
        assert.deepEqual(tracker.current?.files, ['a.ts'])
    })

    await t.test('counts failed tool calls', () => {
        const tracker = new TurnTracker('name')
        tracker.feed([prompt('u1'), assistant('a1', [use('t1', 'Bash')]), results(2, true)])
        assert.equal(tracker.current?.errors, 1)
    })

    await t.test('collects only the files that were written to', () => {
        // "Touched" should mean changed. Every file read would be most of them.
        const tracker = new TurnTracker('name')
        tracker.feed([
            prompt('u1'),
            assistant('a1', [
                use('t1', 'Read', { file_path: '/x/read-only.ts' }),
                use('t2', 'Edit', { file_path: '/x/changed.ts' }),
                use('t3', 'Write', { file_path: '/x/made.ts' }),
                use('t4', 'Edit', { file_path: '/x/changed.ts' }),
            ]),
        ])
        assert.deepEqual(tracker.current?.files, ['changed.ts', 'made.ts'])
    })

    await t.test('adds up the tokens across the turn', () => {
        const tracker = new TurnTracker('name')
        tracker.feed([
            prompt('u1'),
            assistant('a1', [use('t1', 'Bash')], { tokens: 120 }),
            assistant('a2', [{ type: 'text', text: 'ok' }], { tokens: 80, stop: 'end_turn' }),
        ])
        assert.equal(tracker.current?.outputTokens, 200)
    })

    await t.test('a new prompt closes a turn that never ended', () => {
        // An interrupted turn would otherwise leave its card saying "Working…"
        // for the rest of the session.
        const tracker = new TurnTracker('name')
        tracker.feed([prompt('u1'), assistant('a1', [use('t1', 'Bash')])])
        const kinds = tracker.feed([prompt('u2', 10)]).map((e) => e.kind)
        assert.deepEqual(kinds, ['end', 'start'])
    })

    await t.test('a finished turn does not absorb what comes after it', () => {
        // Not every turn is announced by a string-content user entry: a queued
        // message or a continuation is not. Without this the first turn of a
        // session swallowed every later one, reporting one turn that ran for
        // twenty minutes and firing `end` again each time another finished.
        const tracker = new TurnTracker('name')
        tracker.feed([
            prompt('u1'),
            assistant('a1', [use('t1', 'Bash')], { seconds: 1 }),
            assistant('a2', [{ type: 'text', text: 'first' }], { seconds: 2, stop: 'end_turn' }),
        ])

        const kinds = tracker.feed([
            assistant('a3', [use('t2', 'Edit', { file_path: 'x.ts' })], { seconds: 30 }),
            assistant('a4', [{ type: 'text', text: 'second' }], { seconds: 31, stop: 'end_turn' }),
        ]).map((e) => e.kind)

        assert.deepEqual(kinds, ['start', 'activity', 'text', 'end'])
        // The second turn is its own: one tool, and it started when it started.
        assert.equal(tracker.current?.tools, 1)
        assert.equal(tracker.current?.startedAt, clock + 30_000)
    })

    await t.test('starts a turn when streaming is switched on mid-flight', () => {
        // The first thing seen is assistant output, with no prompt before it.
        const tracker = new TurnTracker('name')
        const kinds = tracker.feed([assistant('a1', [{ type: 'text', text: 'carrying on' }])])
            .map((e) => e.kind)
        assert.deepEqual(kinds, ['start', 'text'])
    })

    await t.test('detail off records the tool but says nothing about it', () => {
        const tracker = new TurnTracker('none')
        tracker.feed([prompt('u1'), assistant('a1', [use('t1', 'Bash', { description: 'Deploy' })])])
        assert.equal(tracker.current?.tools, 1)
        assert.equal(tracker.current?.activity.length, 0)
    })

    await t.test('detail name gives the name and nothing else', () => {
        const tracker = new TurnTracker('name')
        tracker.feed([prompt('u1'), assistant('a1', [use('t1', 'Bash', { description: 'Deploy' })])])
        assert.deepEqual(tracker.current?.activity, [{ id: 't1', name: 'Bash', target: undefined }])
    })

    await t.test('detail full adds the safe target', () => {
        const tracker = new TurnTracker('detail')
        tracker.feed([prompt('u1'), assistant('a1', [use('t1', 'Bash', { description: 'Deploy it' })])])
        assert.deepEqual(tracker.current?.activity, [{ id: 't1', name: 'Bash', target: 'Deploy it' }])
    })

    await t.test('survives junk in the stream', () => {
        const tracker = new TurnTracker('name')
        assert.deepEqual(tracker.feed([null, undefined, 'a string', 42, {}]), [])
    })
})

test('formatDuration', () => {
    assert.equal(formatDuration(8_000), '8s')
    assert.equal(formatDuration(72_000), '1m 12s')
    assert.equal(formatDuration(3_840_000), '1h 04m')
    assert.equal(formatDuration(-5), '0s')
})

test('formatTokens', () => {
    assert.equal(formatTokens(940), '940')
    assert.equal(formatTokens(2148), '2.1k')
    assert.equal(formatTokens(12000), '12k')
    assert.equal(formatTokens(1_400_000), '1.4M')
})

test('renderTurn', async (t) => {
    const base = (over: Partial<Turn> = {}): Turn => ({
        id: 't', startedAt: 0, phase: 'working',
        activity: [], tools: 0, errors: 0, files: [], outputTokens: 0, ...over,
    })

    await t.test('a running turn ticks and lists recent work', () => {
        const text = renderTurn(base({
            tools: 3, outputTokens: 2148,
            activity: [
                { id: '1', name: 'Read', target: 'webhook.ts' },
                { id: '2', name: 'Bash', target: 'Run the full test suite' },
                { id: '3', name: 'Edit', target: 'turn.ts' },
            ],
        }), 72_000)

        assert.match(text, /^⏳ \*Working…\*/)
        assert.match(text, /1m 12s/)
        assert.match(text, /3 tools/)
        assert.match(text, /2\.1k tokens/)
        assert.match(text, /`Bash`  Run the full test suite/)
    })

    await t.test('counts older lines rather than listing them', () => {
        const activity = Array.from({ length: ACTIVITY_ROWS + 4 }, (_, i) =>
            ({ id: String(i), name: `Tool${i}` }))
        const text = renderTurn(base({ activity, tools: activity.length }), 1000)

        assert.match(text, /_…4 earlier_/)
        assert.doesNotMatch(text, /Tool0/)
        assert.match(text, new RegExp(`Tool${ACTIVITY_ROWS + 3}`))
    })

    await t.test('a finished turn shows what it touched, not what it did', () => {
        const text = renderTurn(base({
            phase: 'done', endedAt: 160_000, tools: 23,
            files: ['webhook.ts', 'turn.ts'],
            activity: [{ id: '1', name: 'Edit' }],
        }), 999_999)

        assert.match(text, /^✅ \*Done\*/)
        assert.match(text, /2m 40s/)
        assert.match(text, /_touched_  `webhook\.ts` `turn\.ts`/)
        assert.doesNotMatch(text, /`Edit`/)
    })

    await t.test('the elapsed time freezes when the turn ends', () => {
        const text = renderTurn(base({ phase: 'done', startedAt: 0, endedAt: 5_000 }), 900_000)
        assert.match(text, /5s/)
    })

    await t.test('says so when something failed', () => {
        const text = renderTurn(base({ phase: 'done', endedAt: 1000, errors: 2 }), 1000)
        assert.match(text, /⚠️ \*Done, with 2 errors\*/)
    })

    await t.test('a turn with nothing yet is still a valid card', () => {
        assert.match(renderTurn(base(), 0), /⏳ \*Working…\*  ·  0s/)
    })

    await t.test('caps the file list', () => {
        const files = Array.from({ length: 20 }, (_, i) => `f${i}.ts`)
        const text = renderTurn(base({ phase: 'done', endedAt: 1, files }), 1)
        assert.match(text, /_\+8 more_/)
    })
})

test('worthShowing', async (t) => {
    const base = (over: Partial<Turn> = {}): Turn => ({
        id: 't', startedAt: 0, phase: 'done', endedAt: 2_000,
        activity: [], tools: 0, errors: 0, files: [], outputTokens: 700, ...over,
    })

    await t.test('a two-second answer with no tools is not worth a card', () => {
        // "Done · 0s · 707 tokens" names no question and reports no work, but
        // still takes a slot in the channel.
        assert.equal(worthShowing(base(), 2_000), false)
    })

    await t.test('any tool call makes it worth showing', () => {
        assert.equal(worthShowing(base({ tools: 1 }), 2_000), true)
    })

    await t.test('so does a failure, however quick', () => {
        assert.equal(worthShowing(base({ errors: 1 }), 2_000), true)
    })

    await t.test('a long turn earns one even with no tools', () => {
        assert.equal(worthShowing(base({ endedAt: undefined }), TRIVIAL_MS + 1), true)
    })
})

test('renderTurn names the question', async (t) => {
    await t.test('shows what was asked', () => {
        // Several finished cards in a channel are otherwise indistinguishable.
        const text = renderTurn({
            id: 't', prompt: 'deploy the staging branch', startedAt: 0,
            endedAt: 5000, phase: 'done', activity: [], tools: 2,
            errors: 0, files: [], outputTokens: 0,
        }, 5000)
        assert.match(text, /_deploy the staging branch_/)
    })

    await t.test('carries no prompt line when there was none', () => {
        const text = renderTurn({
            id: 't', startedAt: 0, endedAt: 5000, phase: 'done',
            activity: [], tools: 1, errors: 0, files: [], outputTokens: 0,
        }, 5000)
        assert.doesNotMatch(text, /^_/m)
    })
})
