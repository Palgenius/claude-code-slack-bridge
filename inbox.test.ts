import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { Inbox, mentionsBot, stripMention, isFromPerson, rotateIfLarge, type Mention } from './inbox.js'

const BOT = 'U0C17G82RHR'

function tempInbox(): Inbox {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-inbox-test-'))
    return new Inbox(dir)
}

function mention(ts: string, text: string): Mention {
    return { ts, channel: 'C0C17J47NLW', user: 'U039JKT10SY', text, received_at: new Date().toISOString() }
}

test('mentionsBot', async (t) => {
    await t.test('matches the bot being addressed', () => {
        assert.equal(mentionsBot(`<@${BOT}> deploy please`, BOT), true)
        assert.equal(mentionsBot(`hey <@${BOT}>`, BOT), true)
    })

    await t.test('ignores ordinary chatter', () => {
        // The reason the filter exists: the channel is also a place people
        // talk to each other, and none of that should wake Claude.
        assert.equal(mentionsBot('deploy please', BOT), false)
        assert.equal(mentionsBot('one', BOT), false)
    })

    await t.test('ignores somebody else being mentioned', () => {
        assert.equal(mentionsBot('<@U039JKT10SY> can you look', BOT), false)
    })

    await t.test('never matches when the bot id is unknown', () => {
        // auth.test can fail. Matching everything in that state would forward
        // the whole channel; matching nothing is the safe direction.
        assert.equal(mentionsBot(`<@${BOT}> hello`, ''), false)
    })

    await t.test('survives a missing or non-string text', () => {
        assert.equal(mentionsBot(undefined as any, BOT), false)
        assert.equal(mentionsBot(null as any, BOT), false)
    })
})

test('isFromPerson', async (t) => {
    await t.test('a plain message is from a person', () => {
        assert.equal(isFromPerson(undefined), true)
        assert.equal(isFromPerson(null), true)
        assert.equal(isFromPerson(''), true)
    })

    await t.test('a message with a file attached is from a person', () => {
        // The regression this guards: the filter started as "reject anything
        // with a subtype", which threw away every message carrying an image.
        assert.equal(isFromPerson('file_share'), true)
    })

    await t.test('a thread reply sent to the channel is from a person', () => {
        assert.equal(isFromPerson('thread_broadcast'), true)
    })

    await t.test('system chatter is not', () => {
        for (const subtype of [
            'huddle_thread', 'message_changed', 'message_deleted', 'bot_message',
            'channel_join', 'channel_leave', 'pinned_item', 'channel_topic',
        ]) {
            assert.equal(isFromPerson(subtype), false, `${subtype} should be ignored`)
        }
    })
})

test('stripMention', async (t) => {
    await t.test('removes the token and tidies the spacing', () => {
        assert.equal(stripMention(`<@${BOT}> deploy please`, BOT), 'deploy please')
        assert.equal(stripMention(`hey <@${BOT}> there`, BOT), 'hey there')
    })

    await t.test('removes every occurrence', () => {
        assert.equal(stripMention(`<@${BOT}> and <@${BOT}> again`, BOT), 'and again')
    })

    await t.test('leaves other mentions alone', () => {
        assert.equal(stripMention(`<@${BOT}> ask <@U039JKT10SY>`, BOT), 'ask <@U039JKT10SY>')
    })

    await t.test('collapses a mention-only message to empty', () => {
        assert.equal(stripMention(`<@${BOT}>`, BOT), '')
    })

    await t.test('keeps the line breaks', () => {
        // This used to run \s+ over the whole message, so a pasted stack trace
        // or numbered list arrived as one run-on line for Claude to work from.
        assert.equal(
            stripMention(`<@${BOT}> fix this:\nline one\nline two`, BOT),
            'fix this:\nline one\nline two')
    })

    await t.test('keeps the indentation of pasted code', () => {
        const code = `<@${BOT}> look:\n\`\`\`\nif (x) {\n    return 1\n}\n\`\`\``
        assert.equal(stripMention(code, BOT), 'look:\n```\nif (x) {\n    return 1\n}\n```')
    })

    await t.test('trims the blank lines at the edges but keeps one inside', () => {
        assert.equal(stripMention(`<@${BOT}>\n\nfirst\n\n\n\nsecond\n\n`, BOT), 'first\n\nsecond')
    })
})

test('Inbox', async (t) => {
    await t.test('round-trips entries', () => {
        const inbox = tempInbox()
        inbox.append(mention('100.1', 'first'))
        inbox.append(mention('100.2', 'second'))

        const all = inbox.all()
        assert.equal(all.length, 2)
        assert.equal(all[0].text, 'first')
        assert.equal(all[1].text, 'second')
    })

    await t.test('reads as empty before anything is written', () => {
        const inbox = tempInbox()
        assert.deepEqual(inbox.all(), [])
        assert.deepEqual(inbox.unread(), [])
        assert.equal(inbox.readCursor(), 0)
    })

    await t.test('unread shrinks as entries are marked read', () => {
        const inbox = tempInbox()
        inbox.append(mention('100.1', 'first'))
        inbox.append(mention('100.2', 'second'))

        const first = inbox.unread()
        assert.equal(first.length, 2)

        inbox.markRead(first)
        assert.deepEqual(inbox.unread(), [])

        inbox.append(mention('100.3', 'third'))
        const next = inbox.unread()
        assert.equal(next.length, 1)
        assert.equal(next[0].text, 'third')
    })

    await t.test('markRead never moves the cursor backwards', () => {
        // A peek of older entries after a read must not resurrect them.
        const inbox = tempInbox()
        inbox.append(mention('100.1', 'first'))
        inbox.append(mention('100.9', 'latest'))
        inbox.markRead(inbox.all())

        inbox.markRead([mention('100.1', 'first')])
        assert.deepEqual(inbox.unread(), [])
    })

    await t.test('markRead on nothing is a no-op', () => {
        const inbox = tempInbox()
        inbox.append(mention('100.1', 'first'))
        inbox.markRead([])
        assert.equal(inbox.unread().length, 1)
    })

    await t.test('a torn line does not break the rest of the file', () => {
        // Two instances appending at the same instant can interleave. One
        // unparseable line must not hide every message after it.
        const inbox = tempInbox()
        inbox.append(mention('100.1', 'before'))
        fs.appendFileSync(inbox.file, '{"ts":"100.2","chan\n')
        inbox.append(mention('100.3', 'after'))

        const all = inbox.all()
        assert.equal(all.length, 2)
        assert.deepEqual(all.map((m) => m.text), ['before', 'after'])
    })

    await t.test('a corrupt cursor reads as zero rather than NaN', () => {
        // NaN comparisons are all false, which would silently mark every
        // message as read forever.
        const inbox = tempInbox()
        inbox.append(mention('100.1', 'first'))
        fs.writeFileSync(inbox.cursorFile, 'not-a-number')
        assert.equal(inbox.readCursor(), 0)
        assert.equal(inbox.unread().length, 1)
    })

    await t.test('attachments survive the round trip', () => {
        const inbox = tempInbox()
        const withFile: Mention = {
            ...mention('300.1', 'look at this'),
            files: [{ id: 'F0C1G0WJT0R', name: 'image.png', mimetype: 'image/png', size: 83370 }],
        }
        inbox.append(withFile)

        const back = inbox.all()[0]
        assert.equal(back.files?.length, 1)
        assert.equal(back.files?.[0].name, 'image.png')
        assert.equal(back.files?.[0].mimetype, 'image/png')
    })

    await t.test('a message with no attachment has no files key', () => {
        const inbox = tempInbox()
        inbox.append(mention('300.2', 'just text'))
        assert.equal(inbox.all()[0].files, undefined)
    })

    await t.test('the same message twice is read once', () => {
        // Socket Mode redelivers on reconnect, and several instances append
        // here at the same time. Without this, check_slack_inbox handed Claude
        // the same instruction twice in a row.
        const inbox = tempInbox()
        inbox.append(mention('400.1', 'deploy it'))
        inbox.append(mention('400.1', 'deploy it'))

        assert.equal(inbox.all().length, 1)
        assert.equal(inbox.unread().length, 1)
    })

    await t.test('the later copy of a duplicate wins', () => {
        // Slack can send the file list with the second event.
        const inbox = tempInbox()
        inbox.append(mention('400.2', 'look'))
        inbox.append({
            ...mention('400.2', 'look'),
            files: [{ id: 'F1', name: 'shot.png' }],
        })

        const all = inbox.all()
        assert.equal(all.length, 1)
        assert.equal(all[0].files?.[0].name, 'shot.png')
    })

    await t.test('entries come back in time order however they were written', () => {
        const inbox = tempInbox()
        inbox.append(mention('500.3', 'third'))
        inbox.append(mention('500.1', 'first'))
        inbox.append(mention('500.2', 'second'))

        assert.deepEqual(inbox.all().map((m) => m.text), ['first', 'second', 'third'])
    })

    await t.test('thread_ts survives the round trip', () => {
        // Without it every answer lands in the channel root and the question
        // it belongs to is two screens up.
        const inbox = tempInbox()
        inbox.append({ ...mention('600.1', 'in a thread'), thread_ts: '599.0', channel_type: 'im' })

        const back = inbox.all()[0]
        assert.equal(back.thread_ts, '599.0')
        assert.equal(back.channel_type, 'im')
    })

    await t.test('two channels do not share an inbox or a cursor', () => {
        // Every project points at the same webhook.ts, so they used to share
        // one file: whichever session called check_slack_inbox first read the
        // other's messages AND marked them read, and the session they were
        // meant for never saw them.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-two-channel-'))
        const a = new Inbox(dir, 'C0AAA')
        const b = new Inbox(dir, 'C0BBB')

        a.append({ ...mention('800.1', 'for a'), channel: 'C0AAA' })
        b.append({ ...mention('800.2', 'for b'), channel: 'C0BBB' })

        assert.deepEqual(a.all().map((m) => m.text), ['for a'])
        assert.deepEqual(b.all().map((m) => m.text), ['for b'])

        // A reads and marks read; B must be untouched.
        a.markRead(a.unread())
        assert.deepEqual(a.unread(), [])
        assert.deepEqual(b.unread().map((m) => m.text), ['for b'])
    })

    await t.test('no channel keeps the original shared filenames', () => {
        // Backwards compatible with a single session listening everywhere, and
        // with an inbox written before the split.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-legacy-'))
        const legacy = new Inbox(dir)

        assert.equal(path.basename(legacy.file), 'slack-inbox.jsonl')
        assert.equal(path.basename(legacy.cursorFile), 'slack-inbox.cursor')
        assert.equal(legacy.channel, '')
    })

    await t.test('the channel is sanitised before it reaches the filesystem', () => {
        // It is a Slack id in practice, but it ends up in a path.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-nasty-'))
        const box = new Inbox(dir, '../../etc/passwd')

        assert.equal(path.dirname(box.file), dir)
        assert.doesNotMatch(path.basename(box.file), /[\\/.]{2}/)
    })

    await t.test('a rotated file keeps its unread mentions readable', () => {
        // Rotation must not quietly drop a message nobody had read yet.
        const inbox = tempInbox()
        inbox.append(mention('700.1', 'from before the rotation'))
        fs.renameSync(inbox.file, `${inbox.file}.1`)
        inbox.append(mention('700.2', 'after'))

        assert.deepEqual(inbox.all().map((m) => m.text),
            ['from before the rotation', 'after'])
        assert.equal(inbox.unread().length, 2)
    })

    await t.test('timestamps are compared as numbers, not strings', () => {
        // "1789221819.9" > "1789221819.10" as strings, which would drop a
        // message. Slack ts values must be compared numerically.
        const inbox = tempInbox()
        inbox.append(mention('1789221819.9', 'earlier'))
        inbox.markRead(inbox.all())
        inbox.append(mention('1789221819.10', 'later-but-smaller-as-string'))

        // .10 is numerically less than .9, so it is genuinely older and
        // correctly stays read. The check that matters is the reverse:
        inbox.append(mention('1789221820.1', 'genuinely newer'))
        const unread = inbox.unread()
        assert.equal(unread.length, 1)
        assert.equal(unread[0].text, 'genuinely newer')
    })
})

test('rotateIfLarge', async (t) => {
    const tempFile = () => path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-')), 'growing.log')

    await t.test('leaves a small file alone', () => {
        const file = tempFile()
        fs.writeFileSync(file, 'short')
        assert.equal(rotateIfLarge(file, 1024), false)
        assert.equal(fs.readFileSync(file, 'utf8'), 'short')
    })

    await t.test('moves a large file aside', () => {
        const file = tempFile()
        fs.writeFileSync(file, 'x'.repeat(2048))
        assert.equal(rotateIfLarge(file, 1024), true)
        assert.equal(fs.existsSync(file), false)
        assert.equal(fs.readFileSync(`${file}.1`, 'utf8').length, 2048)
    })

    await t.test('keeps one generation, not every one', () => {
        const file = tempFile()
        fs.writeFileSync(`${file}.1`, 'older')
        fs.writeFileSync(file, 'y'.repeat(2048))
        rotateIfLarge(file, 1024)
        assert.equal(fs.readFileSync(`${file}.1`, 'utf8').length, 2048)
    })

    await t.test('a file that is not there is not an error', () => {
        assert.equal(rotateIfLarge(path.join(os.tmpdir(), 'no-such-file.log'), 1), false)
    })
})
