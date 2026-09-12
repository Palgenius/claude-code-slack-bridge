/**
 * Uploading a file and creating a canvas.
 *
 * Neither is reachable through chat.postMessage, so each needs its own call
 * sequence. `fetch` and `fs` are injected so the sequences can be tested
 * without a Slack workspace.
 *
 * Scopes: files:write for uploads, canvases:write for canvases.
 */

import * as fs from 'fs'
import * as path from 'path'
import { toMrkdwn, splitForSlack, MAX_TEXT } from './mrkdwn.js'

export { MAX_TEXT }

export interface Deps {
    fetch: typeof globalThis.fetch
    readFile: (p: string) => Buffer
    statSize: (p: string) => number
    exists: (p: string) => boolean
}

export const realDeps: Deps = {
    fetch: (...args) => globalThis.fetch(...args),
    readFile: (p) => fs.readFileSync(p),
    statSize: (p) => fs.statSync(p).size,
    exists: (p) => fs.existsSync(p),
}

export interface Result {
    ok: boolean
    detail: string
    id?: string
}

/** Slack's own cap is far higher, but nothing here should be sending a DVD. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

/**
 * A long message is split into at most this many posts.
 *
 * Past it the remainder is dropped with a note saying so. Something has gone
 * wrong upstream if a single reply needs forty messages, and a channel filling
 * for a minute is a worse outcome than a truncated one.
 */
export const MAX_PARTS = 8

async function callApi(
    deps: Deps, token: string, method: string, body: unknown, form = false
): Promise<any> {
    const res = await deps.fetch(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: form
            ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }
            : { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: form
            ? new URLSearchParams(body as Record<string, string>).toString()
            : JSON.stringify(body),
    })
    return res.json()
}

function clamp(text: string): string {
    if (text.length <= MAX_TEXT) return text
    return `${text.slice(0, MAX_TEXT)}\n\n…(truncated)`
}

/**
 * `mrkdwn: false` turns the conversion off for a caller that has already done
 * it -- the progress board builds its own mrkdwn, and running the converter
 * over output that is already converted would re-read its own asterisks.
 */
export interface SendOpts {
    token: string
    channel: string
    text: string
    /** Reply inside this thread rather than at the top of the channel. */
    thread_ts?: string
    mrkdwn?: boolean
}

function prepare(text: string, convert?: boolean): string {
    return convert === false ? text : toMrkdwn(text)
}

/**
 * Post a message and hand back its timestamp.
 *
 * The timestamp is the whole point: it is the handle `updateMessage` needs.
 * Without it a progress report can only ever be a new message, and a long job
 * turns the channel into a scroll of half-finished thoughts.
 *
 * A message over Slack's limit is split across several posts rather than
 * truncated. It used to lose its tail, which on a long answer meant losing the
 * conclusion -- the part actually worth reading. The parts after the first go
 * into a thread hanging off the first, so the channel shows one message and
 * the rest is there for whoever wants it.
 */
export async function postMessage(
    opts: SendOpts,
    deps: Deps = realDeps
): Promise<Result> {
    if (!opts.text.trim()) return { ok: false, detail: 'text is empty' }

    const parts = splitForSlack(prepare(opts.text, opts.mrkdwn))
    const sending = parts.slice(0, MAX_PARTS)
    if (parts.length > MAX_PARTS) {
        sending[MAX_PARTS - 1] += `\n\n_…and ${parts.length - MAX_PARTS} more part(s), not sent_`
    }

    let first = ''
    for (const [index, part] of sending.entries()) {
        const res = await callApi(deps, opts.token, 'chat.postMessage', {
            channel: opts.channel,
            text: clamp(part),
            // Continuations hang off the first part when this was not already
            // a threaded reply, so a long answer stays one item in the channel.
            ...(opts.thread_ts ? { thread_ts: opts.thread_ts }
                : index > 0 && first ? { thread_ts: first } : {}),
        })
        if (!res?.ok) {
            const where = index === 0 ? '' : ` (part ${index + 1} of ${sending.length})`
            return { ok: false, detail: `chat.postMessage failed${where}: ${res?.error || 'unknown'}`, id: first || undefined }
        }
        if (index === 0) first = res.ts
    }

    const spread = sending.length > 1 ? ` in ${sending.length} parts` : ''
    const where = opts.thread_ts ? `thread ${opts.thread_ts}` : opts.channel
    return { ok: true, detail: `posted to ${where}${spread}`, id: first }
}

/**
 * Rewrite a message already posted.
 *
 * This is what makes a "working on it" marker bearable: one line in the
 * channel that changes as the job moves, rather than five lines of noise.
 * Slack only allows editing the bot's own messages, which is the behaviour
 * wanted here anyway.
 */
export async function updateMessage(
    opts: { token: string, channel: string, ts: string, text: string, mrkdwn?: boolean },
    deps: Deps = realDeps
): Promise<Result> {
    if (!opts.ts) return { ok: false, detail: 'ts is required — it identifies the message to rewrite' }
    if (!opts.text.trim()) return { ok: false, detail: 'text is empty' }

    // An edit cannot be split: there is one message to rewrite, so this is the
    // one place truncation is still the only option.
    const res = await callApi(deps, opts.token, 'chat.update', {
        channel: opts.channel,
        ts: opts.ts,
        text: clamp(prepare(opts.text, opts.mrkdwn)),
    })
    if (!res?.ok) {
        // message_not_found here almost always means the ts came from a
        // different channel, or the message was posted by somebody else.
        return { ok: false, detail: `chat.update failed: ${res?.error || 'unknown'}` }
    }

    return { ok: true, detail: `updated ${opts.ts} in ${opts.channel}`, id: opts.ts }
}

/**
 * Delete a message this bot posted.
 *
 * Used to keep the status line to exactly one message while still moving it to
 * the bottom of the channel: post the new one, then remove the old. In that
 * order, so there is never a moment with no status at all.
 *
 * Scope: chat:write -- the same one posting uses. There is no `chat:delete`
 * scope; Slack's reference for the method lists `chat:write` for both bot and
 * user tokens.
 */
export async function deleteMessage(
    opts: { token: string, channel: string, ts: string },
    deps: Deps = realDeps
): Promise<Result> {
    if (!opts.ts) return { ok: false, detail: 'ts is required' }

    const res = await callApi(deps, opts.token, 'chat.delete', {
        channel: opts.channel, ts: opts.ts,
    })
    if (!res?.ok) {
        // message_not_found means somebody already deleted it, which is the
        // outcome wanted. Anything else is worth reporting.
        if (res?.error === 'message_not_found') {
            return { ok: true, detail: 'already gone' }
        }
        return { ok: false, detail: `chat.delete failed: ${res?.error || 'unknown'}` }
    }
    return { ok: true, detail: `deleted ${opts.ts}` }
}

/**
 * Pin a message to the channel.
 *
 * A pinned status line is reachable from the channel's pinned items no matter
 * how far the conversation has moved on. `already_pinned` is a success.
 *
 * Scope: pins:write.
 */
export async function pinMessage(
    opts: { token: string, channel: string, ts: string },
    deps: Deps = realDeps
): Promise<Result> {
    if (!opts.ts) return { ok: false, detail: 'ts is required' }

    const res = await callApi(deps, opts.token, 'pins.add', {
        channel: opts.channel, timestamp: opts.ts,
    })
    if (!res?.ok && res?.error !== 'already_pinned') {
        return { ok: false, detail: `pins.add failed: ${res?.error || 'unknown'}` }
    }
    return { ok: true, detail: `pinned ${opts.ts}` }
}

/**
 * Put a reaction on a message, taking a previous one off first.
 *
 * This is what makes the channel legible at a glance: your own message shows
 * 👀 the moment Claude picks it up and ✅ when the answer is finished, so a
 * question that was never seen is obvious without reading anything.
 *
 * Failures are reported but are never worth failing a turn over -- a missing
 * `reactions:write` scope should cost the decoration, not the answer. Slack
 * says `already_reacted` when the emoji is already there, which is a success
 * as far as this is concerned.
 *
 * Scope: reactions:write.
 */
export async function react(
    opts: { token: string, channel: string, ts: string, emoji: string, remove?: string[] },
    deps: Deps = realDeps
): Promise<Result> {
    if (!opts.ts) return { ok: false, detail: 'ts is required' }

    for (const gone of opts.remove || []) {
        if (gone === opts.emoji) continue
        await callApi(deps, opts.token, 'reactions.remove',
            { channel: opts.channel, timestamp: opts.ts, name: gone })
    }

    const res = await callApi(deps, opts.token, 'reactions.add',
        { channel: opts.channel, timestamp: opts.ts, name: opts.emoji })

    if (!res?.ok && res?.error !== 'already_reacted') {
        return { ok: false, detail: `reactions.add failed: ${res?.error || 'unknown'}` }
    }
    return { ok: true, detail: `reacted :${opts.emoji}: on ${opts.ts}` }
}

/**
 * Upload a local file into a channel.
 *
 * files.upload is deprecated and now refuses, so this is the three-step
 * replacement: ask for a URL, PUT the bytes to it, then tell Slack the bytes
 * landed. Any of the three can fail independently, and a failure in the
 * middle leaves an orphaned upload slot rather than a visible file — so the
 * step that failed is named in the result.
 */
export async function uploadFile(
    opts: {
        token: string, channel: string, filePath: string,
        title?: string, comment?: string, thread_ts?: string,
    },
    deps: Deps = realDeps
): Promise<Result> {
    const { token, channel, filePath } = opts

    if (!deps.exists(filePath)) {
        return { ok: false, detail: `no such file: ${filePath}` }
    }
    const size = deps.statSize(filePath)
    if (size === 0) {
        // Slack accepts the slot and then the file never appears, which is
        // far harder to diagnose than refusing here.
        return { ok: false, detail: `file is empty: ${filePath}` }
    }
    if (size > MAX_UPLOAD_BYTES) {
        return { ok: false, detail: `file is ${Math.round(size / 1048576)}MB, over the ${MAX_UPLOAD_BYTES / 1048576}MB limit` }
    }

    const filename = path.basename(filePath)

    const slot = await callApi(deps, token, 'files.getUploadURLExternal',
        { filename, length: String(size) }, true)
    if (!slot?.ok) {
        return { ok: false, detail: `getUploadURLExternal failed: ${slot?.error || 'unknown'}` }
    }

    const put = await deps.fetch(slot.upload_url, { method: 'POST', body: deps.readFile(filePath) as any })
    if (!put.ok) {
        return { ok: false, detail: `uploading the bytes failed: HTTP ${put.status}` }
    }

    const done = await callApi(deps, token, 'files.completeUploadExternal', {
        files: [{ id: slot.file_id, title: opts.title || filename }],
        channel_id: channel,
        ...(opts.comment ? { initial_comment: toMrkdwn(opts.comment) } : {}),
        ...(opts.thread_ts ? { thread_ts: opts.thread_ts } : {}),
    })
    if (!done?.ok) {
        return { ok: false, detail: `completeUploadExternal failed: ${done?.error || 'unknown'}` }
    }

    return { ok: true, detail: `uploaded ${filename} (${Math.round(size / 1024)}KB) to ${channel}`, id: slot.file_id }
}

/**
 * Create a canvas and put it in a channel.
 *
 * A channel holds at most one canvas, so `channel_canvas_already_exists` is an
 * expected answer rather than an error: fall back to a standalone canvas and
 * share it into the channel, which gives the same result with an extra call.
 */
export async function createCanvas(
    opts: { token: string, channel: string, title: string, markdown: string },
    deps: Deps = realDeps
): Promise<Result> {
    const { token, channel, title, markdown } = opts

    if (!markdown.trim()) return { ok: false, detail: 'markdown is empty' }

    const document_content = { type: 'markdown', markdown }

    const attached = await callApi(deps, token, 'conversations.canvases.create',
        { channel_id: channel, document_content })
    if (attached?.ok) {
        return { ok: true, detail: `created the channel canvas for ${channel}`, id: attached.canvas_id }
    }

    const standalone = await callApi(deps, token, 'canvases.create', { title, document_content })
    if (!standalone?.ok) {
        return {
            ok: false,
            detail: `both routes failed: conversations.canvases.create said "${attached?.error || 'unknown'}", canvases.create said "${standalone?.error || 'unknown'}"`,
        }
    }

    const shared = await callApi(deps, token, 'canvases.access.set', {
        canvas_id: standalone.canvas_id,
        access_level: 'write',
        channel_ids: [channel],
    })
    if (!shared?.ok) {
        // The canvas exists but nobody can reach it from the channel. Worth
        // saying so rather than reporting a plain success.
        return {
            ok: true,
            detail: `created standalone canvas but sharing it to ${channel} failed: ${shared?.error || 'unknown'}`,
            id: standalone.canvas_id,
        }
    }

    return { ok: true, detail: `created a standalone canvas and shared it to ${channel}`, id: standalone.canvas_id }
}
