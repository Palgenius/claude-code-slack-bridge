/**
 * Turning a session transcript into something that reads like watching Claude
 * work, rather than a log being copied into a channel.
 *
 * The streamer used to post each block as it appeared: a wall of disconnected
 * messages with no sense of a beginning, an end, or anything in between. The
 * terminal UI does not feel like that because it has a *turn* -- you ask,
 * something visibly works, an answer arrives. That structure is all in the
 * transcript already and just was not being read:
 *
 *   - a `user` entry whose content is a plain string is somebody asking
 *   - `assistant` entries with `stop_reason: "tool_use"` are work continuing
 *   - `stop_reason: "end_turn"` is the answer being finished
 *   - `user` entries holding `tool_result` are the work coming back
 *
 * So this tracks a turn and emits events for it, and webhook.ts renders that
 * as one card in Slack that rewrites itself while the work runs.
 *
 * Nothing here does any I/O, which is the point: the rendering is the part
 * worth testing and webhook.ts opens a socket the moment it is imported.
 */

import * as path from 'path'
import { redact } from './transcript.js'

/**
 * How much of a tool call is allowed into the channel.
 *
 * `none` says nothing about tools at all. `name` is the tool's name only --
 * what the original streamer did. `detail` adds a short target, and is off by
 * default because it is a real disclosure: the file names in a repository and
 * the one-line descriptions written for commands. It never includes a command
 * string, a pattern's surrounding code, or any file content.
 */
export type ToolDetail = 'none' | 'name' | 'detail'

export interface Activity {
    /** The tool_use id, which is what makes a re-read line idempotent. */
    id: string
    name: string
    target?: string
}

export interface Turn {
    id: string
    /**
     * What was asked, shortened.
     *
     * Without it a finished card reads "Done, 35s" and says nothing about
     * which of several questions it answered -- in a channel with a few turns
     * in it they become indistinguishable from each other.
     */
    prompt?: string
    startedAt: number
    endedAt?: number
    phase: 'working' | 'done'
    activity: Activity[]
    tools: number
    errors: number
    /** Basenames only. A full path says more about the machine than is useful. */
    files: string[]
    outputTokens: number
}

export type TurnEvent =
    | { kind: 'start', turn: Turn }
    | { kind: 'activity', turn: Turn }
    | { kind: 'text', turn: Turn, text: string }
    | { kind: 'end', turn: Turn }

/** Keys that name a file, in the order a tool is likely to use them. */
const FILE_KEYS = ['file_path', 'notebook_path', 'path']

/**
 * A short, safe label for what a tool call was aimed at.
 *
 * `description` comes first deliberately: Bash and the agent tools carry a
 * one-line human-readable summary written to be read, which is far better than
 * anything that could be derived from the command itself -- and means the
 * command never has to be looked at.
 *
 * Everything returned goes through the same redaction the prose does, because
 * a path or a search pattern can carry a secret as easily as a sentence can.
 */
export function toolTarget(input: unknown): string | undefined {
    if (!input || typeof input !== 'object') return undefined
    const fields = input as Record<string, unknown>

    let value: string | undefined

    if (typeof fields.description === 'string' && fields.description.trim()) {
        value = fields.description.trim()
    } else {
        for (const key of FILE_KEYS) {
            if (typeof fields[key] === 'string' && fields[key]) {
                value = path.basename(String(fields[key]))
                break
            }
        }
        if (!value && typeof fields.pattern === 'string') value = fields.pattern
        if (!value && typeof fields.url === 'string') value = String(fields.url)
        if (!value && typeof fields.query === 'string') value = String(fields.query)
    }

    if (!value) return undefined
    const safe = redact(value).replace(/\s+/g, ' ').trim()
    return safe.length > 72 ? `${safe.slice(0, 71)}…` : safe
}

/** `mcp__ccd_session__mark_chapter` reads as `mark_chapter`. */
export function shortToolName(name: string): string {
    const value = String(name || '')
    if (!value.startsWith('mcp__')) return value
    const parts = value.split('__').filter(Boolean)
    return parts[parts.length - 1] || value
}

/** The basename of any file a tool call names, for the "touched" summary. */
function fileFrom(input: unknown): string | undefined {
    if (!input || typeof input !== 'object') return undefined
    const fields = input as Record<string, unknown>
    for (const key of FILE_KEYS) {
        if (typeof fields[key] === 'string' && fields[key]) return path.basename(String(fields[key]))
    }
    return undefined
}

/** Tools that change a file, so "touched" means touched rather than read. */
const WRITING_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])

/** The asked question, redacted and cut to something that fits one line. */
function askedText(content: unknown): string | undefined {
    if (typeof content !== 'string') return undefined
    const clean = redact(content).replace(/\s+/g, ' ').trim()
    if (!clean) return undefined
    return clean.length > 80 ? `${clean.slice(0, 79)}…` : clean
}

function newTurn(id: string, at: number, prompt?: string): Turn {
    return {
        id, prompt, startedAt: at, phase: 'working',
        activity: [], tools: 0, errors: 0, files: [], outputTokens: 0,
    }
}

/**
 * Walks transcript entries and reports where the turn has got to.
 *
 * Feeding it entries it has already seen is safe: activity is keyed on the
 * tool_use id and text on the block's position, because the tailer re-reads a
 * line that was half-written when it last looked.
 */
export class TurnTracker {
    private turn: Turn | null = null
    private seen = new Set<string>()
    private counter = 0

    constructor(private readonly detail: ToolDetail = 'name') { }

    /** The turn in progress, if there is one. */
    get current(): Turn | null {
        return this.turn
    }

    feed(entries: unknown[]): TurnEvent[] {
        const events: TurnEvent[] = []

        for (const raw of entries) {
            const entry = raw as any
            if (!entry || typeof entry !== 'object') continue
            // A subagent's own transcript. Its work shows up in the parent as
            // the Task call that started it, which is the level worth watching.
            if (entry.isSidechain) continue

            const at = Date.parse(entry.timestamp) || Date.now()

            if (entry.type === 'user') {
                // Content as a plain string is a person asking for something.
                // An array is tool results coming back, which is not a new turn.
                if (typeof entry.message?.content === 'string') {
                    if (this.turn && this.turn.phase === 'working') {
                        // Interrupted: the previous turn never reached end_turn.
                        this.turn.phase = 'done'
                        this.turn.endedAt = at
                        events.push({ kind: 'end', turn: this.snapshot() })
                    }
                    this.turn = newTurn(
                        String(entry.uuid || `turn-${++this.counter}`), at,
                        askedText(entry.message.content))
                    events.push({ kind: 'start', turn: this.snapshot() })
                    continue
                }

                for (const block of entry.message?.content || []) {
                    if (block?.is_error && this.turn) this.turn.errors++
                }
                continue
            }

            if (entry.type !== 'assistant') continue

            // A turn that has already ended must not absorb what comes after
            // it. Not every new turn is announced by a string-content user
            // entry -- a queued message or a continuation is not -- and
            // without this the first turn of a session swallowed every one
            // after it, reporting a single turn that ran for twenty minutes
            // and emitting `end` again each time another finished.
            //
            // Streaming can also be switched on mid-turn, in which case the
            // first thing seen is assistant output with no prompt before it.
            if (!this.turn || this.turn.phase === 'done') {
                this.turn = newTurn(String(entry.uuid || `turn-${++this.counter}`), at)
                events.push({ kind: 'start', turn: this.snapshot() })
            }

            const blocks = entry.message?.content
            if (Array.isArray(blocks)) {
                let index = 0
                for (const block of blocks) {
                    const key = `${entry.uuid}:${index++}`

                    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
                        if (this.seen.has(key)) continue
                        this.seen.add(key)
                        events.push({ kind: 'text', turn: this.snapshot(), text: redact(block.text) })
                    } else if (block?.type === 'tool_use' && block.name) {
                        const id = String(block.id || key)
                        if (this.seen.has(id)) continue
                        this.seen.add(id)

                        this.turn.tools++
                        const file = fileFrom(block.input)
                        if (file && WRITING_TOOLS.has(block.name) && !this.turn.files.includes(file)) {
                            this.turn.files.push(file)
                        }
                        if (this.detail !== 'none') {
                            this.turn.activity.push({
                                id,
                                name: shortToolName(block.name),
                                target: this.detail === 'detail' ? toolTarget(block.input) : undefined,
                            })
                        }
                        events.push({ kind: 'activity', turn: this.snapshot() })
                    }
                    // `thinking` falls through, and has no path to an event.
                }
            }

            const used = entry.message?.usage?.output_tokens
            if (typeof used === 'number') this.turn.outputTokens += used

            if (entry.message?.stop_reason === 'end_turn') {
                this.turn.phase = 'done'
                this.turn.endedAt = at
                events.push({ kind: 'end', turn: this.snapshot() })
            }
        }

        return events
    }

    private snapshot(): Turn {
        const turn = this.turn as Turn
        return { ...turn, activity: [...turn.activity], files: [...turn.files] }
    }
}

/** "8s", "1m 12s", "1h 04m" — the shape a glance can read. */
export function formatDuration(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000))
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** 2148 -> "2.1k". Exact numbers here are noise; the order of magnitude is not. */
export function formatTokens(count: number): string {
    if (count < 1000) return String(count)
    if (count < 1000000) return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`
    return `${(count / 1000000).toFixed(1).replace(/\.0$/, '')}M`
}

/** How many tool lines the card shows before it starts summarising. */
export const ACTIVITY_ROWS = 6

/**
 * The card, as Slack mrkdwn.
 *
 * Already mrkdwn, so it must be sent with the converter off -- running it over
 * this would have the italic rule read the asterisks written here.
 *
 * The most recent activity is at the bottom, the way a terminal scrolls, and
 * older lines are counted rather than listed. When the turn finishes the
 * activity gives way to the files it touched, because at that point what was
 * done matters more than the order it happened in.
 */
/**
 * Whether a turn is worth a card at all.
 *
 * A card for a turn that took two seconds and called nothing says only "✅ Done
 * · 0s · 707 tokens" — it names no question, reports no work, and still takes a
 * slot in the channel. A handful of those and the channel is mostly the bot
 * announcing that it finished things nobody watched it start.
 */
export function worthShowing(turn: Turn, now: number = Date.now()): boolean {
    if (turn.tools > 0 || turn.errors > 0) return true
    return (turn.endedAt ?? now) - turn.startedAt >= TRIVIAL_MS
}

/** Under this, with no tools, a turn is not worth a line in the channel. */
export const TRIVIAL_MS = 10_000

export function renderTurn(turn: Turn, now: number = Date.now()): string {
    const elapsed = formatDuration((turn.endedAt ?? now) - turn.startedAt)

    const facts = [elapsed]
    if (turn.tools > 0) facts.push(`${turn.tools} ${turn.tools === 1 ? 'tool' : 'tools'}`)
    if (turn.outputTokens > 0) facts.push(`${formatTokens(turn.outputTokens)} tokens`)

    const lines: string[] = []

    if (turn.phase === 'working') {
        lines.push(`⏳ *Working…*  ·  ${facts.join('  ·  ')}`)
    } else if (turn.errors > 0) {
        const label = `${turn.errors} ${turn.errors === 1 ? 'error' : 'errors'}`
        lines.push(`⚠️ *Done, with ${label}*  ·  ${facts.join('  ·  ')}`)
    } else {
        lines.push(`✅ *Done*  ·  ${facts.join('  ·  ')}`)
    }

    // What was asked, so a finished card is identifiable. Several cards in a
    // channel are otherwise indistinguishable from one another.
    if (turn.prompt) lines.push(`_${turn.prompt}_`)

    if (turn.phase === 'working' && turn.activity.length > 0) {
        const hidden = turn.activity.length - ACTIVITY_ROWS
        if (hidden > 0) lines.push('', `_…${hidden} earlier_`)
        else lines.push('')

        for (const item of turn.activity.slice(-ACTIVITY_ROWS)) {
            lines.push(item.target ? `\`${item.name}\`  ${item.target}` : `\`${item.name}\``)
        }
    }

    if (turn.phase === 'done' && turn.files.length > 0) {
        const shown = turn.files.slice(0, 12).map((f) => `\`${f}\``).join(' ')
        const more = turn.files.length > 12 ? ` _+${turn.files.length - 12} more_` : ''
        lines.push('', `_touched_  ${shown}${more}`)
    }

    return lines.join('\n')
}
