import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { redact, parseLines, findTranscript, TranscriptTailer } from './transcript.js'

function tmpdir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-test-'))
}

const assistant = (uuid: string, blocks: any[]) =>
    JSON.stringify({ type: 'assistant', uuid, message: { content: blocks } })

const text = (t: string) => ({ type: 'text', text: t })
const thinking = (t: string) => ({ type: 'thinking', thinking: t })
const tool = (name: string, input: any = {}) => ({ type: 'tool_use', name, input })

test('redact', async (t) => {
    await t.test('masks the Apache config line that actually leaked', () => {
        // This is the real shape, from DBDParams in a live vhost. It went
        // into the terminal during the session this was written in; a
        // streamer without redaction would have posted it to Slack.
        const line = 'DBDParams "host=127.0.0.1,port=3306,dbname=sso_portal,user=apache_gateway,pass=8d94b2458834071c04cade38d45f8e22294c542d999f60d3"'
        const out = redact(line)
        assert.doesNotMatch(out, /8d94b245/)
        assert.match(out, /pass=\[redacted\]/)
        // The useful, non-secret parts survive, or the output is worthless.
        assert.match(out, /host=127\.0\.0\.1/)
        assert.match(out, /dbname=sso_portal/)
    })

    await t.test('masks Slack tokens, including this tool\'s own', () => {
        assert.match(redact('SLACK_BOT_TOKEN=xoxb-123456789012-abcdefghij'), /\[redacted\]/)
        assert.doesNotMatch(redact('token: xapp-1-A123456789-abcdefghij'), /abcdefghij/)
    })

    await t.test('masks credentials in a connection string but keeps the shape', () => {
        const out = redact('mysql://portal:s3cretpw@207.180.198.206:3306/sso_portal')
        assert.doesNotMatch(out, /s3cretpw/)
        assert.match(out, /mysql:\/\/\[redacted\]@/)
        assert.match(out, /sso_portal/)
    })

    await t.test('masks bearer headers and private keys', () => {
        assert.match(redact('Authorization: Bearer abcdefghijklmnop123'), /Bearer \[redacted\]/)
        const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKC\n-----END RSA PRIVATE KEY-----'
        assert.equal(redact(key), '[redacted private key]')
    })

    await t.test('masks a long hex run, which is always a key or a hash', () => {
        assert.match(redact('secret is a3f1c0de9b8a7f6e5d4c3b2a1908f7e6'), /\[redacted hex\]/)
    })

    await t.test('leaves ordinary prose and short hex alone', () => {
        // Over-masking would make the stream unreadable, which defeats it.
        const prose = 'Fixed the redirect loop in src/middleware/auth.js at line 71. Commit e3d1ca2.'
        assert.equal(redact(prose), prose)
        assert.equal(redact('colour #0d0c16 on #e8ecf6'), 'colour #0d0c16 on #e8ecf6')
    })

    await t.test('handles a non-string without throwing', () => {
        assert.equal(redact(undefined as any), 'undefined')
    })
})

test('parseLines', async (t) => {
    await t.test('emits text blocks', () => {
        const out = parseLines(assistant('u1', [text('Deployed and verified.')]))
        assert.equal(out.length, 1)
        assert.equal(out[0].kind, 'text')
        assert.equal(out[0].text, 'Deployed and verified.')
    })

    await t.test('NEVER emits thinking, whatever else is in the entry', () => {
        // The single most important assertion here. Thinking is private
        // reasoning, not something anybody chose to say out loud.
        const out = parseLines(assistant('u2', [
            thinking('Let me consider whether this is a trap...'),
            text('Here is the answer.'),
        ]))
        assert.equal(out.length, 1)
        assert.equal(out[0].text, 'Here is the answer.')
        assert.equal(JSON.stringify(out).includes('consider whether'), false)
    })

    await t.test('drops thinking even when it is the only block', () => {
        assert.deepEqual(parseLines(assistant('u3', [thinking('private')])), [])
    })

    await t.test('ignores tool blocks unless asked, and then only the name', () => {
        const line = assistant('u4', [tool('Bash', { command: 'cat /etc/shadow' })])
        assert.deepEqual(parseLines(line), [])

        const withTools = parseLines(line, { tools: true })
        assert.equal(withTools.length, 1)
        assert.equal(withTools[0].text, '→ Bash')
        // Tool inputs carry commands and file contents. Never included.
        assert.equal(JSON.stringify(withTools).includes('shadow'), false)
    })

    await t.test('redacts on the way out', () => {
        const out = parseLines(assistant('u5', [text('the pass=hunter2bigsecret is set')]))
        assert.doesNotMatch(out[0].text, /hunter2bigsecret/)
    })

    await t.test('skips user entries and other types', () => {
        const lines = [
            JSON.stringify({ type: 'user', message: { content: 'hello' } }),
            JSON.stringify({ type: 'system', content: 'note' }),
            assistant('u6', [text('mine')]),
        ].join('\n')
        const out = parseLines(lines)
        assert.equal(out.length, 1)
        assert.equal(out[0].text, 'mine')
    })

    await t.test('survives a malformed line', () => {
        // These files are appended to live; a torn line is normal.
        const lines = `{"type":"assistant","uuid":"bad",\n${assistant('u7', [text('after')])}`
        const out = parseLines(lines)
        assert.equal(out.length, 1)
        assert.equal(out[0].text, 'after')
    })

    await t.test('ignores empty and whitespace-only text', () => {
        assert.deepEqual(parseLines(assistant('u8', [text('   \n ')])), [])
    })
})

test('TranscriptTailer', async (t) => {
    await t.test('treats what is already written as history', () => {
        // Otherwise switching streaming on replays the whole session into
        // the channel, which for a long session is thousands of messages.
        const dir = tmpdir()
        const file = path.join(dir, 's.jsonl')
        fs.writeFileSync(file, assistant('old', [text('from before')]) + '\n')

        const tailer = new TranscriptTailer(file)
        assert.deepEqual(tailer.next(), [])

        fs.appendFileSync(file, assistant('new', [text('after starting')]) + '\n')
        const out = tailer.next()
        assert.equal(out.length, 1)
        assert.equal(out[0].text, 'after starting')
    })

    await t.test('reads history when explicitly asked', () => {
        const dir = tmpdir()
        const file = path.join(dir, 's.jsonl')
        fs.writeFileSync(file, assistant('old', [text('from before')]) + '\n')

        const out = new TranscriptTailer(file, { fromStart: true }).next()
        assert.equal(out.length, 1)
    })

    await t.test('waits for a partial line to be finished', () => {
        const dir = tmpdir()
        const file = path.join(dir, 's.jsonl')
        fs.writeFileSync(file, '')
        const tailer = new TranscriptTailer(file)

        const whole = assistant('u1', [text('complete message')]) + '\n'
        fs.appendFileSync(file, whole.slice(0, 30))   // torn mid-write
        assert.deepEqual(tailer.next(), [])

        fs.appendFileSync(file, whole.slice(30))
        const out = tailer.next()
        assert.equal(out.length, 1)
        assert.equal(out[0].text, 'complete message')
    })

    await t.test('does not repeat a block', () => {
        const dir = tmpdir()
        const file = path.join(dir, 's.jsonl')
        fs.writeFileSync(file, '')
        const tailer = new TranscriptTailer(file)

        fs.appendFileSync(file, assistant('u1', [text('once')]) + '\n')
        assert.equal(tailer.next().length, 1)
        assert.deepEqual(tailer.next(), [])
    })

    await t.test('starts over if the file is truncated or replaced', () => {
        const dir = tmpdir()
        const file = path.join(dir, 's.jsonl')
        fs.writeFileSync(file, assistant('a', [text('first session')]) + '\n')
        const tailer = new TranscriptTailer(file)

        fs.writeFileSync(file, assistant('b', [text('replaced')]) + '\n')
        const out = tailer.next()
        assert.equal(out.length, 1)
        assert.equal(out[0].text, 'replaced')
    })

    await t.test('a missing file is quiet, not fatal', () => {
        const tailer = new TranscriptTailer(path.join(tmpdir(), 'nope.jsonl'))
        assert.deepEqual(tailer.next(), [])
    })
})

test('findTranscript', async (t) => {
    await t.test('prefers the session id over mtime', () => {
        // The deterministic route: two sessions in one folder must not be
        // confused, and the newest file is not necessarily this session.
        const root = tmpdir()
        const proj = path.join(root, 'E--some-project')
        fs.mkdirSync(proj)
        fs.writeFileSync(path.join(proj, 'wanted.jsonl'), '')
        fs.writeFileSync(path.join(proj, 'newer.jsonl'), '')

        const found = findTranscript({ dir: root, sessionId: 'wanted' });
        assert.equal(path.basename(found || ''), 'wanted.jsonl')
    })

    await t.test('falls back to the newest transcript', () => {
        const root = tmpdir()
        const proj = path.join(root, 'p')
        fs.mkdirSync(proj)
        fs.writeFileSync(path.join(proj, 'old.jsonl'), '')
        fs.writeFileSync(path.join(proj, 'new.jsonl'), '')
        // Make the intended one unambiguously newer.
        const future = Date.now() + 60_000
        fs.utimesSync(path.join(proj, 'new.jsonl'), future / 1000, future / 1000)

        assert.equal(path.basename(findTranscript({ dir: root }) || ''), 'new.jsonl')
    })

    await t.test('returns null when there is nothing to follow', () => {
        assert.equal(findTranscript({ dir: path.join(tmpdir(), 'absent') }), null)
        assert.equal(findTranscript({ dir: tmpdir() }), null)
    })
})
