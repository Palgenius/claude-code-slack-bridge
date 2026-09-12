import test from 'node:test'
import assert from 'node:assert/strict'

import {
    uploadFile, createCanvas, postMessage, updateMessage, react,
    deleteMessage, pinMessage, MAX_UPLOAD_BYTES, MAX_TEXT, type Deps,
} from './slackRich.js'

const TOKEN = 'xoxb-test'
const CHANNEL = 'C01ABCDEFGH'

/**
 * A fake Slack. `plan` maps an api method (or 'PUT' for the upload URL) to the
 * body it answers with; every call is recorded so the sequence can be checked.
 *
 * `bodies` keeps the last body per method, which is what most of these tests
 * want. `sent` keeps every one in order, for the cases where a single call
 * turns into several posts.
 */
function fakeSlack(plan: Record<string, any>) {
    const calls: string[] = []
    const bodies: Record<string, any> = {}
    const sent: { method: string, body: any }[] = []

    const deps: Deps = {
        fetch: (async (url: any, init: any) => {
            const href = String(url)
            if (!href.startsWith('https://slack.com/api/')) {
                calls.push('PUT')
                const answer = plan['PUT'] ?? { status: 200 }
                return { ok: answer.status === 200, status: answer.status } as any
            }
            const method = href.replace('https://slack.com/api/', '')
            calls.push(method)
            try {
                bodies[method] = typeof init.body === 'string' && init.body.startsWith('{')
                    ? JSON.parse(init.body)
                    : init.body
            } catch { bodies[method] = init.body }
            sent.push({ method, body: bodies[method] })
            const answer = plan[method] ?? { ok: false, error: 'unplanned_call' }
            return { ok: true, status: 200, json: async () => answer } as any
        }) as any,
        readFile: () => Buffer.from('pretend png bytes'),
        statSize: () => 4096,
        exists: () => true,
    }

    return { deps, calls, bodies, sent }
}

test('postMessage', async (t) => {
    await t.test('returns the timestamp, which is the handle for editing', async () => {
        // Without the ts coming back, progress can only ever be a new message.
        const { deps, bodies } = fakeSlack({ 'chat.postMessage': { ok: true, ts: '1789.001' } })
        const r = await postMessage({ token: TOKEN, channel: CHANNEL, text: 'working' }, deps)

        assert.equal(r.ok, true)
        assert.equal(r.id, '1789.001')
        assert.equal(bodies['chat.postMessage'].text, 'working')
    })

    await t.test('refuses empty text without calling Slack', async () => {
        const { deps, calls } = fakeSlack({})
        const r = await postMessage({ token: TOKEN, channel: CHANNEL, text: '  \n ' }, deps)
        assert.equal(r.ok, false)
        assert.deepEqual(calls, [])
    })

    await t.test('splits a long message rather than losing its tail', async () => {
        // Slack rejects anything over 4000 chars outright. Truncating kept the
        // message but lost the conclusion, which is the part worth reading.
        const { deps, sent } = fakeSlack({ 'chat.postMessage': { ok: true, ts: '1789.001' } })
        const body = Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n')
        const r = await postMessage({ token: TOKEN, channel: CHANNEL, text: body }, deps)

        assert.equal(r.ok, true)
        assert.ok(sent.length > 1, 'should have taken more than one post')
        for (const post of sent) assert.ok(post.body.text.length < 4000)
        assert.equal(sent.map((p) => p.body.text).join('\n'), body)
    })

    await t.test('hangs the continuation off the first part', async () => {
        // One item in the channel with the rest in a thread, rather than six
        // messages in a row nobody asked for.
        const { deps, sent } = fakeSlack({ 'chat.postMessage': { ok: true, ts: '1789.001' } })
        await postMessage({ token: TOKEN, channel: CHANNEL, text: 'z'.repeat(9000) }, deps)

        assert.ok(sent.length > 1)
        assert.equal(sent[0].body.thread_ts, undefined)
        for (const post of sent.slice(1)) assert.equal(post.body.thread_ts, '1789.001')
    })

    await t.test('returns the first ts even when a later part fails', async () => {
        // The message is partly in the channel; the caller needs the handle to
        // the part that did land.
        let count = 0
        const { deps } = fakeSlack({})
        const plan = deps.fetch
        deps.fetch = (async (url: any, init: any) => {
            count++
            return {
                ok: true, status: 200,
                json: async () => count === 1
                    ? { ok: true, ts: '1789.001' }
                    : { ok: false, error: 'ratelimited' },
            } as any
        }) as any
        void plan

        const r = await postMessage({ token: TOKEN, channel: CHANNEL, text: 'z'.repeat(9000) }, deps)
        assert.equal(r.ok, false)
        assert.equal(r.id, '1789.001')
        assert.match(r.detail, /part 2/)
    })

    await t.test('converts markdown on the way out', async () => {
        const { deps, bodies } = fakeSlack({ 'chat.postMessage': { ok: true, ts: '1' } })
        await postMessage({ token: TOKEN, channel: CHANNEL, text: '# Done\n**all** [ok](https://x.dev)' }, deps)
        assert.equal(bodies['chat.postMessage'].text, '*Done*\n*all* <https://x.dev|ok>')
    })

    await t.test('leaves text alone when the caller already made mrkdwn', async () => {
        // The progress board renders its own; converting it again would have
        // the italic rule read the asterisks the board just wrote.
        const { deps, bodies } = fakeSlack({ 'chat.postMessage': { ok: true, ts: '1' } })
        await postMessage({ token: TOKEN, channel: CHANNEL, text: '*Deploy*', mrkdwn: false }, deps)
        assert.equal(bodies['chat.postMessage'].text, '*Deploy*')
    })

    await t.test('replies into a thread when given one', async () => {
        const { deps, bodies } = fakeSlack({ 'chat.postMessage': { ok: true, ts: '1789.002' } })
        const r = await postMessage(
            { token: TOKEN, channel: CHANNEL, text: 'answer', thread_ts: '1789.001' }, deps)

        assert.equal(bodies['chat.postMessage'].thread_ts, '1789.001')
        assert.match(r.detail, /thread 1789\.001/)
    })

    await t.test('reports the Slack error', async () => {
        const { deps } = fakeSlack({ 'chat.postMessage': { ok: false, error: 'channel_not_found' } })
        const r = await postMessage({ token: TOKEN, channel: CHANNEL, text: 'hi' }, deps)
        assert.equal(r.ok, false)
        assert.match(r.detail, /channel_not_found/)
    })
})

test('updateMessage', async (t) => {
    await t.test('rewrites the message in place', async () => {
        const { deps, calls, bodies } = fakeSlack({ 'chat.update': { ok: true } })
        const r = await updateMessage(
            { token: TOKEN, channel: CHANNEL, ts: '1789.001', text: 'done' }, deps)

        assert.equal(r.ok, true)
        assert.deepEqual(calls, ['chat.update'])
        assert.equal(bodies['chat.update'].ts, '1789.001')
        assert.equal(bodies['chat.update'].text, 'done')
    })

    await t.test('refuses without a ts, which is what identifies the message', async () => {
        const { deps, calls } = fakeSlack({})
        const r = await updateMessage(
            { token: TOKEN, channel: CHANNEL, ts: '', text: 'done' }, deps)
        assert.equal(r.ok, false)
        assert.match(r.detail, /ts is required/)
        assert.deepEqual(calls, [])
    })

    await t.test('surfaces message_not_found instead of pretending it worked', async () => {
        // Usually a ts from a different channel. Silently succeeding would
        // leave a stale "working on it" sitting there forever.
        const { deps } = fakeSlack({ 'chat.update': { ok: false, error: 'message_not_found' } })
        const r = await updateMessage(
            { token: TOKEN, channel: CHANNEL, ts: '1789.999', text: 'done' }, deps)
        assert.equal(r.ok, false)
        assert.match(r.detail, /message_not_found/)
    })

    await t.test('truncates a long update too', async () => {
        const { deps, bodies } = fakeSlack({ 'chat.update': { ok: true } })
        await updateMessage(
            { token: TOKEN, channel: CHANNEL, ts: '1', text: 'y'.repeat(MAX_TEXT + 500) }, deps)
        assert.ok(bodies['chat.update'].text.length < 4000)
    })
})

test('uploadFile', async (t) => {
    await t.test('walks all three steps in order', async () => {
        const { deps, calls, bodies } = fakeSlack({
            'files.getUploadURLExternal': { ok: true, upload_url: 'https://files.slack.com/upload/x', file_id: 'F123' },
            'PUT': { status: 200 },
            'files.completeUploadExternal': { ok: true },
        })

        const r = await uploadFile({ token: TOKEN, channel: CHANNEL, filePath: '/tmp/a.png' }, deps)

        assert.equal(r.ok, true)
        assert.equal(r.id, 'F123')
        // The order matters: a URL cannot be completed before it is requested.
        assert.deepEqual(calls, [
            'files.getUploadURLExternal', 'PUT', 'files.completeUploadExternal',
        ])
        assert.equal(bodies['files.completeUploadExternal'].channel_id, CHANNEL)
        assert.equal(bodies['files.completeUploadExternal'].files[0].id, 'F123')
    })

    await t.test('defaults the title to the filename', async () => {
        const { deps, bodies } = fakeSlack({
            'files.getUploadURLExternal': { ok: true, upload_url: 'u', file_id: 'F1' },
            'files.completeUploadExternal': { ok: true },
        })
        await uploadFile({ token: TOKEN, channel: CHANNEL, filePath: '/tmp/sso-routes.png' }, deps)
        assert.equal(bodies['files.completeUploadExternal'].files[0].title, 'sso-routes.png')
    })

    await t.test('omits initial_comment when none is given', async () => {
        // Sending an empty comment posts a blank line under the file.
        const { deps, bodies } = fakeSlack({
            'files.getUploadURLExternal': { ok: true, upload_url: 'u', file_id: 'F1' },
            'files.completeUploadExternal': { ok: true },
        })
        await uploadFile({ token: TOKEN, channel: CHANNEL, filePath: '/tmp/a.png' }, deps)
        assert.equal('initial_comment' in bodies['files.completeUploadExternal'], false)
    })

    await t.test('refuses a missing file without calling Slack', async () => {
        const { deps, calls } = fakeSlack({})
        deps.exists = () => false
        const r = await uploadFile({ token: TOKEN, channel: CHANNEL, filePath: '/tmp/gone.png' }, deps)
        assert.equal(r.ok, false)
        assert.match(r.detail, /no such file/)
        assert.deepEqual(calls, [])
    })

    await t.test('refuses an empty file', async () => {
        // Slack issues the slot and the file then never appears, which is
        // much harder to diagnose than refusing up front.
        const { deps, calls } = fakeSlack({})
        deps.statSize = () => 0
        const r = await uploadFile({ token: TOKEN, channel: CHANNEL, filePath: '/tmp/empty.png' }, deps)
        assert.equal(r.ok, false)
        assert.match(r.detail, /empty/)
        assert.deepEqual(calls, [])
    })

    await t.test('refuses a file over the size cap', async () => {
        const { deps, calls } = fakeSlack({})
        deps.statSize = () => MAX_UPLOAD_BYTES + 1
        const r = await uploadFile({ token: TOKEN, channel: CHANNEL, filePath: '/tmp/big.mp4' }, deps)
        assert.equal(r.ok, false)
        assert.match(r.detail, /over the/)
        assert.deepEqual(calls, [])
    })

    await t.test('names the step that failed', async () => {
        const cases: [Record<string, any>, RegExp][] = [
            [{ 'files.getUploadURLExternal': { ok: false, error: 'missing_scope' } }, /getUploadURLExternal failed: missing_scope/],
            [{
                'files.getUploadURLExternal': { ok: true, upload_url: 'u', file_id: 'F1' },
                'PUT': { status: 413 },
            }, /uploading the bytes failed: HTTP 413/],
            [{
                'files.getUploadURLExternal': { ok: true, upload_url: 'u', file_id: 'F1' },
                'files.completeUploadExternal': { ok: false, error: 'channel_not_found' },
            }, /completeUploadExternal failed: channel_not_found/],
        ]
        for (const [plan, expected] of cases) {
            const { deps } = fakeSlack(plan)
            const r = await uploadFile({ token: TOKEN, channel: CHANNEL, filePath: '/tmp/a.png' }, deps)
            assert.equal(r.ok, false)
            assert.match(r.detail, expected)
        }
    })
})

test('createCanvas', async (t) => {
    const md = '## Title\n\nSome content.'

    await t.test('uses the channel canvas when the channel has none', async () => {
        const { deps, calls } = fakeSlack({
            'conversations.canvases.create': { ok: true, canvas_id: 'F0C1' },
        })
        const r = await createCanvas({ token: TOKEN, channel: CHANNEL, title: 'T', markdown: md }, deps)

        assert.equal(r.ok, true)
        assert.equal(r.id, 'F0C1')
        // No fallback calls when the first route works.
        assert.deepEqual(calls, ['conversations.canvases.create'])
    })

    await t.test('falls back to a standalone canvas and shares it', async () => {
        // A channel holds at most one canvas, so this is an expected answer
        // rather than a failure.
        const { deps, calls, bodies } = fakeSlack({
            'conversations.canvases.create': { ok: false, error: 'channel_canvas_already_exists' },
            'canvases.create': { ok: true, canvas_id: 'F0C2' },
            'canvases.access.set': { ok: true },
        })
        const r = await createCanvas({ token: TOKEN, channel: CHANNEL, title: 'T', markdown: md }, deps)

        assert.equal(r.ok, true)
        assert.equal(r.id, 'F0C2')
        assert.match(r.detail, /standalone/)
        assert.deepEqual(calls, ['conversations.canvases.create', 'canvases.create', 'canvases.access.set'])
        assert.deepEqual(bodies['canvases.access.set'].channel_ids, [CHANNEL])
    })

    await t.test('reports a canvas that exists but could not be shared', async () => {
        // Silently succeeding would leave a canvas nobody in the channel
        // can open.
        const { deps } = fakeSlack({
            'conversations.canvases.create': { ok: false, error: 'channel_canvas_already_exists' },
            'canvases.create': { ok: true, canvas_id: 'F0C3' },
            'canvases.access.set': { ok: false, error: 'restricted_action' },
        })
        const r = await createCanvas({ token: TOKEN, channel: CHANNEL, title: 'T', markdown: md }, deps)

        assert.equal(r.ok, true)
        assert.equal(r.id, 'F0C3')
        assert.match(r.detail, /sharing it to .* failed: restricted_action/)
    })

    await t.test('reports both errors when neither route works', async () => {
        const { deps } = fakeSlack({
            'conversations.canvases.create': { ok: false, error: 'missing_scope' },
            'canvases.create': { ok: false, error: 'missing_scope' },
        })
        const r = await createCanvas({ token: TOKEN, channel: CHANNEL, title: 'T', markdown: md }, deps)

        assert.equal(r.ok, false)
        assert.match(r.detail, /conversations.canvases.create said "missing_scope"/)
        assert.match(r.detail, /canvases.create said "missing_scope"/)
    })

    await t.test('refuses empty markdown without calling Slack', async () => {
        const { deps, calls } = fakeSlack({})
        const r = await createCanvas({ token: TOKEN, channel: CHANNEL, title: 'T', markdown: '   \n ' }, deps)
        assert.equal(r.ok, false)
        assert.deepEqual(calls, [])
    })

    await t.test('sends the markdown as a markdown document', async () => {
        const { deps, bodies } = fakeSlack({
            'conversations.canvases.create': { ok: true, canvas_id: 'F0C4' },
        })
        await createCanvas({ token: TOKEN, channel: CHANNEL, title: 'T', markdown: md }, deps)
        assert.deepEqual(bodies['conversations.canvases.create'].document_content,
            { type: 'markdown', markdown: md })
    })
})

test('react', async (t) => {
    await t.test('adds the emoji to the message', async () => {
        const { deps, calls, bodies } = fakeSlack({ 'reactions.add': { ok: true } })
        const r = await react({ token: TOKEN, channel: CHANNEL, ts: '1789.001', emoji: 'eyes' }, deps)

        assert.equal(r.ok, true)
        assert.deepEqual(calls, ['reactions.add'])
        assert.equal(bodies['reactions.add'].timestamp, '1789.001')
        assert.equal(bodies['reactions.add'].name, 'eyes')
    })

    await t.test('takes the previous one off first', async () => {
        // The lifecycle is one reaction at a time: watching, then finished.
        const { deps, calls } = fakeSlack({
            'reactions.remove': { ok: true },
            'reactions.add': { ok: true },
        })
        await react({
            token: TOKEN, channel: CHANNEL, ts: '1789.001',
            emoji: 'white_check_mark', remove: ['eyes'],
        }, deps)

        assert.deepEqual(calls, ['reactions.remove', 'reactions.add'])
    })

    await t.test('does not remove the emoji it is about to add', async () => {
        const { deps, calls } = fakeSlack({ 'reactions.add': { ok: true } })
        await react({ token: TOKEN, channel: CHANNEL, ts: '1', emoji: 'eyes', remove: ['eyes'] }, deps)
        assert.deepEqual(calls, ['reactions.add'])
    })

    await t.test('already_reacted is a success, not a failure', async () => {
        // Re-reacting is the expected outcome of a retry, and it means the
        // message is in the state that was wanted.
        const { deps } = fakeSlack({ 'reactions.add': { ok: false, error: 'already_reacted' } })
        const r = await react({ token: TOKEN, channel: CHANNEL, ts: '1', emoji: 'eyes' }, deps)
        assert.equal(r.ok, true)
    })

    await t.test('reports a missing scope rather than pretending', async () => {
        const { deps } = fakeSlack({ 'reactions.add': { ok: false, error: 'missing_scope' } })
        const r = await react({ token: TOKEN, channel: CHANNEL, ts: '1', emoji: 'eyes' }, deps)
        assert.equal(r.ok, false)
        assert.match(r.detail, /missing_scope/)
    })

    await t.test('refuses without a ts', async () => {
        const { deps, calls } = fakeSlack({})
        const r = await react({ token: TOKEN, channel: CHANNEL, ts: '', emoji: 'eyes' }, deps)
        assert.equal(r.ok, false)
        assert.deepEqual(calls, [])
    })
})

test('deleteMessage', async (t) => {
    await t.test('removes the message', async () => {
        const { deps, calls, bodies } = fakeSlack({ 'chat.delete': { ok: true } })
        const r = await deleteMessage({ token: TOKEN, channel: CHANNEL, ts: '1789.001' }, deps)

        assert.equal(r.ok, true)
        assert.deepEqual(calls, ['chat.delete'])
        assert.equal(bodies['chat.delete'].ts, '1789.001')
    })

    await t.test('already gone counts as success', async () => {
        // The outcome wanted is "that message is not there", and it is not.
        const { deps } = fakeSlack({ 'chat.delete': { ok: false, error: 'message_not_found' } })
        const r = await deleteMessage({ token: TOKEN, channel: CHANNEL, ts: '1' }, deps)
        assert.equal(r.ok, true)
    })

    await t.test('reports a missing scope rather than pretending', async () => {
        // Without chat:delete the old status line stays put, and the channel
        // ends up with two. Worth saying so in the log.
        const { deps } = fakeSlack({ 'chat.delete': { ok: false, error: 'missing_scope' } })
        const r = await deleteMessage({ token: TOKEN, channel: CHANNEL, ts: '1' }, deps)
        assert.equal(r.ok, false)
        assert.match(r.detail, /missing_scope/)
    })

    await t.test('refuses without a ts', async () => {
        const { deps, calls } = fakeSlack({})
        assert.equal((await deleteMessage({ token: TOKEN, channel: CHANNEL, ts: '' }, deps)).ok, false)
        assert.deepEqual(calls, [])
    })
})

test('pinMessage', async (t) => {
    await t.test('pins it', async () => {
        const { deps, calls, bodies } = fakeSlack({ 'pins.add': { ok: true } })
        const r = await pinMessage({ token: TOKEN, channel: CHANNEL, ts: '1789.001' }, deps)

        assert.equal(r.ok, true)
        assert.deepEqual(calls, ['pins.add'])
        assert.equal(bodies['pins.add'].timestamp, '1789.001')
    })

    await t.test('already pinned counts as success', async () => {
        const { deps } = fakeSlack({ 'pins.add': { ok: false, error: 'already_pinned' } })
        assert.equal((await pinMessage({ token: TOKEN, channel: CHANNEL, ts: '1' }, deps)).ok, true)
    })

    await t.test('reports a missing scope', async () => {
        const { deps } = fakeSlack({ 'pins.add': { ok: false, error: 'missing_scope' } })
        const r = await pinMessage({ token: TOKEN, channel: CHANNEL, ts: '1' }, deps)
        assert.equal(r.ok, false)
        assert.match(r.detail, /missing_scope/)
    })
})
