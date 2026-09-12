/**
 * A single line in the channel saying whether anything is listening.
 *
 * Without it there is no way to tell a quiet channel from a dead one: you
 * write a message, nothing answers, and the bridge being down looks exactly
 * like Claude being busy. This says which it is.
 *
 * Deliberately *one* message that gets rewritten, not a notice per startup.
 * A session restarts often, and a channel filling with "connected… connected…
 * connected" is worse than no signal at all -- each line is stale the moment
 * the next one lands, and none of them tells you the current state. The
 * timestamp is kept on disk so a restart finds the message it posted last time
 * and edits it in place.
 */

import * as fs from 'fs'
import * as path from 'path'

export interface Presence {
    /** The project this session is working in, for channels shared by several. */
    project: string
    online: boolean
    /** When this session connected. */
    since: number
    /** When it went away; only used when offline. */
    until?: number
}

/** "51m", "2h 05m", "34s" -- how long it has been up, at a glance. */
export function formatUptime(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000))
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m`
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

function clock(at: number): string {
    const d = new Date(at)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * The status line, as Slack mrkdwn.
 *
 * Already mrkdwn: send it with the converter off, or the italics and asterisks
 * here get read a second time.
 */
export function renderPresence(p: Presence, now: number = Date.now()): string {
    const project = p.project ? ` · ${p.project}` : ''

    if (p.online) {
        return [
            `🟢 *Claude is connected*${project}`,
            `_Listening here since ${clock(p.since)} — @mention me and I'll pick it up._`,
        ].join('\n')
    }

    const ended = p.until ?? now
    return [
        `⚪ *Claude is offline*${project}`,
        `_Was connected ${clock(p.since)}–${clock(ended)} (${formatUptime(ended - p.since)}). `
        + `Nothing is listening in this channel right now._`,
    ].join('\n')
}

/**
 * Remembers which message is this channel's status line.
 *
 * On disk rather than in memory, because the whole point is to survive the
 * restart -- an in-memory timestamp would post a fresh message every time,
 * which is the behaviour this exists to avoid. Keyed by channel so two
 * projects on one machine do not fight over one line.
 */
export class StatusStore {
    readonly file: string

    constructor(dir: string, channel: string) {
        const key = String(channel || '').replace(/[^A-Za-z0-9_-]/g, '')
        this.file = path.join(dir, `slack-status${key ? `-${key}` : ''}.json`)
    }

    /** The timestamp of the status message, or '' if there is not one yet. */
    read(): string {
        try {
            const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'))
            return typeof saved?.ts === 'string' ? saved.ts : ''
        } catch {
            return ''
        }
    }

    write(ts: string): void {
        try {
            fs.writeFileSync(this.file, JSON.stringify({ ts, at: Date.now() }))
        } catch {
            // Losing this costs one duplicated status message on the next
            // start, which is not worth failing a startup over.
        }
    }

    clear(): void {
        try { fs.rmSync(this.file) } catch { /* already gone */ }
    }
}

/**
 * Which project this session is in, for the status line.
 *
 * The working directory is what Claude Code spawns the server in, so its
 * basename is the project folder. `SLACK_PROJECT_NAME` overrides it for the
 * cases where that name means nothing to the people reading the channel.
 */
export function projectName(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
    const given = String(env.SLACK_PROJECT_NAME || '').trim()
    if (given) return given
    const base = path.basename(cwd)
    // The server's own directory is not a project -- that is what you get when
    // it was launched by hand rather than by a session.
    return base === 'Claude-Code-Slack-Channel' ? '' : base
}
