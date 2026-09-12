/**
 * Streaming what Claude writes into Slack, by tailing the session transcript.
 *
 * Claude Code has no outbound channel: `notifications/claude/channel` carries
 * Slack -> Claude and there is no counterpart going the other way. But it
 * writes the whole session to a JSONL file as it goes, so tailing that file
 * gives the same result without needing the platform to grow a feature.
 *
 * Works in any project: the session id comes from the environment, and the
 * file is found under the Claude projects directory by that id.
 *
 * Two rules this module exists to enforce:
 *
 *   1. `thinking` blocks are never emitted. They are private reasoning, not
 *      something the author chose to say.
 *   2. Everything else is redacted before it leaves. Claude's prose quotes
 *      files, configuration and command output -- during the session this was
 *      written in, it quoted a database password out of an Apache config. A
 *      streamer without redaction would have posted it to a channel.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

export interface Emitted {
    uuid: string
    kind: 'text' | 'tool'
    text: string
}

/** Where Claude Code keeps per-project session transcripts. */
export function projectsDir(home: string = os.homedir()): string {
    return path.join(home, '.claude', 'projects')
}

/**
 * Locate this session's transcript.
 *
 * Preferred route is the session id, which Claude Code puts in the
 * environment and which is also the file's name -- deterministic, and it
 * cannot pick up a stale session from the same folder. Falling back to
 * newest-by-mtime is for when that variable is absent.
 */
export function findTranscript(opts: {
    home?: string
    sessionId?: string
    dir?: string
} = {}): string | null {
    const root = opts.dir || projectsDir(opts.home)
    if (!fs.existsSync(root)) return null

    const candidates: { file: string, mtime: number }[] = []
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const sub = path.join(root, entry.name)

        if (opts.sessionId) {
            const direct = path.join(sub, `${opts.sessionId}.jsonl`)
            if (fs.existsSync(direct)) return direct
        }

        for (const f of fs.readdirSync(sub)) {
            if (!f.endsWith('.jsonl')) continue
            const full = path.join(sub, f)
            try {
                candidates.push({ file: full, mtime: fs.statSync(full).mtimeMs })
            } catch { /* vanished mid-scan */ }
        }
    }

    if (candidates.length === 0) return null
    candidates.sort((a, b) => b.mtime - a.mtime)
    return candidates[0].file
}

/**
 * Mask anything that looks like a credential.
 *
 * Deliberately eager: a false positive costs a few masked characters in a
 * Slack message, a false negative posts a live secret to a channel. Ordered
 * so the more specific patterns run before the general hex sweep.
 */
export function redact(text: string): string {
    return String(text)
        // Slack's own tokens, which is what this very tool is configured with.
        .replace(/xox[baprs]-[A-Za-z0-9-]{10,}/g, 'xox?-[redacted]')
        .replace(/xapp-[A-Za-z0-9-]{10,}/g, 'xapp-[redacted]')
        // key=value, however it is spelled. This is the one that would have
        // caught the Apache DBDParams line.
        .replace(/\b(pass|passwd|password|pwd|secret|token|api[_-]?key|access[_-]?key)\b(\s*[=:]\s*)("?)([^\s",;)]{4,})/gi,
            (_m, key, sep, quote) => `${key}${sep}${quote}[redacted]`)
        // Authorization headers.
        .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g, '$1 [redacted]')
        // Connection strings: keep the shape, drop the credentials.
        .replace(/\b([a-z][a-z0-9+.-]*):\/\/[^\s:/@]+:[^\s@]+@/gi, '$1://[redacted]@')
        // Private keys.
        .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
            '[redacted private key]')
        .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted aws key]')
        // A long unbroken hex run is a hash, a key or a secret. Sixteen bytes
        // is past the point where anything else looks like this.
        .replace(/\b[0-9a-f]{32,}\b/gi, '[redacted hex]')
}

/**
 * Pull the postable blocks out of a run of transcript lines.
 *
 * `thinking` is dropped here rather than filtered later, so there is no path
 * through this module that can emit it.
 */
export function parseLines(chunk: string, opts: { tools?: boolean } = {}): Emitted[] {
    const out: Emitted[] = []

    for (const line of chunk.split('\n')) {
        if (line.trim() === '') continue
        let entry: any
        try {
            entry = JSON.parse(line)
        } catch {
            continue // a half-written last line; the next read sees it whole
        }
        if (!entry || entry.type !== 'assistant') continue

        const uuid = String(entry.uuid || '')
        const blocks = entry.message?.content
        if (!Array.isArray(blocks)) continue

        for (const block of blocks) {
            if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
                out.push({ uuid, kind: 'text', text: redact(block.text) })
            } else if (opts.tools && block?.type === 'tool_use' && block.name) {
                // Only the name. Tool inputs carry file contents, commands and
                // whatever was read from disk -- far too much to push, and the
                // likeliest place for a secret to hide.
                out.push({ uuid, kind: 'tool', text: `→ ${block.name}` })
            }
            // block.type === 'thinking' falls through: never emitted.
        }
    }

    return out
}

/**
 * Follows one transcript file, handing back only what is new.
 *
 * Tracks a byte offset because these files reach tens of megabytes within a
 * session -- re-reading one every couple of seconds would be the most
 * expensive thing in the process. Deduplicates on uuid as well, since a
 * partial final line gets re-read once it is complete.
 */
export class TranscriptTailer {
    readonly file: string
    private offset = 0
    private seen = new Set<string>()
    private emitTools: boolean

    constructor(file: string, opts: { fromStart?: boolean, tools?: boolean } = {}) {
        this.file = file
        this.emitTools = Boolean(opts.tools)
        if (!opts.fromStart) {
            // Everything already written is history. Without this, turning
            // streaming on would replay the entire session into the channel.
            try { this.offset = fs.statSync(file).size } catch { this.offset = 0 }
        }
    }

    /** Blocks written since the last call. */
    next(): Emitted[] {
        let size: number
        try {
            size = fs.statSync(this.file).size
        } catch {
            return []
        }

        // A smaller file means it was replaced or truncated; start again from
        // the top of the new one rather than reading from a stale offset.
        if (size < this.offset) this.offset = 0
        if (size === this.offset) return []

        const length = size - this.offset
        const buf = Buffer.alloc(length)
        const fd = fs.openSync(this.file, 'r')
        try {
            fs.readSync(fd, buf, 0, length, this.offset)
        } finally {
            fs.closeSync(fd)
        }

        const text = buf.toString('utf8')

        // Stop at the last newline: the tail may be a partially written line,
        // and rewinding to there means it is read once it is complete.
        const cut = text.lastIndexOf('\n')
        if (cut === -1) return []
        this.offset += Buffer.byteLength(text.slice(0, cut + 1), 'utf8')

        const fresh: Emitted[] = []
        for (const item of parseLines(text.slice(0, cut), { tools: this.emitTools })) {
            const key = `${item.uuid}:${item.kind}:${item.text.length}`
            if (this.seen.has(key)) continue
            this.seen.add(key)
            fresh.push(item)
        }
        return fresh
    }
}
