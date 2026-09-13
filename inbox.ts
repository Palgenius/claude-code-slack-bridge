/**
 * The mention inbox.
 *
 * Claude Code only delivers `claude/channel` notifications when its session
 * was started with `--channels`. The Claude desktop app does not pass that
 * flag: the notification is accepted and then dropped by a capability gate,
 * silently, with no error at either end. So mentions are also written to a
 * file, which a watcher can turn into an event and a tool can read back.
 *
 * Kept separate from webhook.ts because that file opens a socket as soon as it
 * is imported, which makes everything in it untestable.
 */

import * as fs from 'fs'
import * as path from 'path'

/**
 * Rename a file out of the way once it passes `limit` bytes.
 *
 * Both the debug log and the inbox are append-only and neither had any bound:
 * a machine left running for weeks ends up with a log nobody can open and a
 * tail read on every poll that gets slower each day. One generation is kept,
 * because the previous file is occasionally worth reading and the one before
 * that never is.
 *
 * Returns true when a rotation happened.
 */
export function rotateIfLarge(file: string, limit: number): boolean {
    try {
        if (!fs.existsSync(file) || fs.statSync(file).size <= limit) return false
        const previous = `${file}.1`
        if (fs.existsSync(previous)) fs.rmSync(previous)
        fs.renameSync(file, previous)
        return true
    } catch {
        // A rotation that cannot happen must not take the server down with it:
        // a large log is a nuisance, a crashed bridge is an outage.
        return false
    }
}

export interface Attachment {
    id: string
    name?: string
    mimetype?: string
    size?: number
    url_private_download?: string
}

export interface Mention {
    ts: string
    channel: string
    user: string
    text: string
    received_at: string
    /**
     * Set when the message was posted in a thread. Carried through so a reply
     * can go back to the same thread rather than to the channel root, which is
     * the difference between a conversation and a pile of unrelated messages.
     */
    thread_ts?: string
    /** `im` for a direct message, `channel` or `group` otherwise. */
    channel_type?: string
    files?: Attachment[]
}

/**
 * Whether a message subtype still means "a person typed this".
 *
 * `file_share` is a message with a file attached; `thread_broadcast` is a
 * thread reply also sent to the channel. Everything else carrying a subtype is
 * not somebody talking: joins, leaves, huddles, edits, deletions, pins, and
 * the bot's own posts.
 *
 * This was first written as "reject anything with a subtype", which threw away
 * every message that had an image attached to it.
 */
export function isFromPerson(subtype?: string | null): boolean {
    if (!subtype) return true
    return subtype === 'file_share' || subtype === 'thread_broadcast'
}

/** True when `text` addresses the bot directly. */
export function mentionsBot(text: string, botUserId: string): boolean {
    if (!botUserId) return false
    return String(text || '').includes(`<@${botUserId}>`)
}

/**
 * The message without the `<@BOT>` token, so the text reads as a sentence.
 *
 * Only horizontal space is collapsed. This used to run `\s+` over the whole
 * message, which flattened every newline: a pasted stack trace, a numbered
 * list or a code block arrived as one unreadable run-on line, and Claude was
 * asked to work from it.
 */
export function stripMention(text: string, botUserId: string): string {
    const value = String(text || '')
    // Only the space around the token that was removed is collapsed. Running
    // this over the whole message would eat the indentation of any code in it.
    const without = botUserId
        ? value.replace(new RegExp(`[ \\t]*<@${botUserId.replace(/[^\w-]/g, '')}>[ \\t]*`, 'g'), ' ')
        : value
    return without
        .replace(/[ \t]+$/gm, '')    // trailing space a removed mention left behind
        .replace(/\n{3,}/g, '\n\n')  // more than one blank line is never meant
        .trim()
}

/**
 * Turn a raw Slack message into a Mention, or decide it is not one.
 *
 * The same three rules the live listener applies, in the same order: a person
 * typed it, it was not us, and it addresses the bot. Written once here so the
 * backfill cannot drift from the live path -- two copies of "what counts as a
 * mention" is precisely the kind of thing that silently diverges and starts
 * collecting the whole channel.
 *
 * `channel` is passed in because a history response does not repeat it on each
 * message the way an event does.
 */
export function toMention(
    raw: unknown, botUserId: string, channel: string
): Mention | null {
    const message = raw as any
    if (!message || typeof message !== 'object' || !message.ts) return null

    if (!isFromPerson(message.subtype)) return null

    const author = String(message.user || '')
    if (!author || author === botUserId) return null

    const text = String(message.text || '')
    if (!mentionsBot(text, botUserId)) return null

    const files = (Array.isArray(message.files) ? message.files : []).map((f: any) => ({
        id: f.id,
        name: f.name,
        mimetype: f.mimetype,
        size: f.size,
        url_private_download: f.url_private_download,
    }))

    return {
        ts: String(message.ts),
        channel: String(channel),
        user: author,
        text: stripMention(text, botUserId),
        // When it actually reached us, which for a backfilled message is now
        // rather than when it was sent. The ts carries the real time.
        received_at: new Date().toISOString(),
        thread_ts: String(message.thread_ts || message.ts),
        ...(files.length > 0 ? { files } : {}),
    }
}

export class Inbox {
    /**
     * Roughly ten thousand mentions. Far beyond any real backlog, and small
     * enough that the whole file is still cheap to parse on every read.
     */
    static readonly MAX_BYTES = 4 * 1024 * 1024

    readonly file: string
    readonly cursorFile: string
    readonly channel: string

    /**
     * One inbox per channel.
     *
     * Every project points its config at the same `webhook.ts`, so every
     * project used to share one inbox and one cursor. Two of them running at
     * once meant whichever called `check_slack_inbox` first read the other's
     * messages *and marked them read*, and the session they were meant for
     * never saw them.
     *
     * Keyed on the channel rather than the project because the channel is what
     * a message belongs to, and it is the one identifier both the server that
     * receives a message and the session that wants it can agree on without
     * being told.
     *
     * With no channel configured this is the old shared file, which is both
     * the sensible behaviour for a single session listening everywhere and
     * backwards compatible with an existing one.
     */
    constructor(dir: string, channel?: string) {
        // Slack ids are already [A-Z0-9] but this string reaches the
        // filesystem, so it is not taken on trust.
        const key = String(channel || '').replace(/[^A-Za-z0-9_-]/g, '')
        const suffix = key ? `-${key}` : ''

        this.channel = key
        this.file = path.join(dir, `slack-inbox${suffix}.jsonl`)
        this.cursorFile = path.join(dir, `slack-inbox${suffix}.cursor`)
    }

    /**
     * Append-only on purpose: Slack load-balances Socket Mode across every
     * connected client, so several server instances may be live at once and
     * all of them can write here without coordinating.
     */
    append(entry: Mention): void {
        rotateIfLarge(this.file, Inbox.MAX_BYTES)
        fs.appendFileSync(this.file, JSON.stringify(entry) + '\n')
    }

    /**
     * Every mention on disk, each one once.
     *
     * Deduplicated by `ts`, which Slack guarantees is unique per message.
     * Socket Mode redelivers an event when a client reconnects, and several
     * instances may be appending here at the same time, so the same message
     * genuinely does land in the file twice -- and without this, reading the
     * inbox handed Claude the same instruction twice in a row.
     */
    all(): Mention[] {
        const byTs = new Map<string, Mention>()

        // The rotated generation first, so a mention that was still unread
        // when the file rolled over is not lost, and so the live file's copy
        // of anything in both wins.
        for (const file of [`${this.file}.1`, this.file]) {
            if (!fs.existsSync(file)) continue
            for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
                if (line.trim() === '') continue
                let entry: Mention
                try {
                    // A torn write from two instances appending at the same
                    // moment would otherwise take down every later read.
                    entry = JSON.parse(line) as Mention
                } catch {
                    continue
                }
                if (!entry || !entry.ts) continue
                // Last write wins: a later copy of the same message is the more
                // complete one, since files can arrive with the second event.
                byTs.set(String(entry.ts), entry)
            }
        }

        return [...byTs.values()].sort((a, b) => Number(a.ts) - Number(b.ts))
    }

    readCursor(): number {
        if (!fs.existsSync(this.cursorFile)) return 0
        const value = Number(fs.readFileSync(this.cursorFile, 'utf8').trim())
        return Number.isFinite(value) ? value : 0
    }

    writeCursor(ts: number): void {
        fs.writeFileSync(this.cursorFile, String(ts))
    }

    unread(): Mention[] {
        const cursor = this.readCursor()
        return this.all().filter((m) => Number(m.ts) > cursor)
    }

    /** Advance the cursor past everything in `entries`. */
    markRead(entries: Mention[]): void {
        if (entries.length === 0) return
        const newest = Math.max(...entries.map((m) => Number(m.ts)))
        // Never move the cursor backwards: a peek followed by a real read of
        // older entries must not un-read anything.
        if (newest > this.readCursor()) this.writeCursor(newest)
    }
}
