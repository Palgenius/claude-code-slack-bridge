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
    /**
     * Whether anything is actually delivering messages to the session.
     *
     * A connected server with no watcher is the failure this whole project
     * keeps being bitten by: outbound works, the channel looks alive, and
     * every message written here sits unread forever. Saying "connected" in
     * that state is a lie of omission, so the line distinguishes them.
     */
    listening?: boolean
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

    if (p.online && p.listening === false) {
        // Connected but deaf. Worth its own colour: the difference between
        // this and green is the difference between "ask me" and "anything you
        // write here will sit unread".
        return [
            `🟡 *Claude is connected but not listening*${project}`,
            `_Nothing is delivering messages to the session, so anything written here will`
            + ` wait unread. The session needs to start its mention watcher._`,
        ].join('\n')
    }

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
 * A heartbeat written by a process that wants to be seen as alive.
 *
 * Two write them: the MCP server (`slack-alive-<channel>.json`) and the
 * mention watcher (`slack-watcher-<channel>.json`). Between them they answer
 * the only two questions that matter when Slack looks dead -- is anything
 * connected, and is anything listening -- which until now could only be
 * answered by reading a log file by hand.
 */
export interface Beat {
    pid: number
    at: number
    channel?: string
}

export type BeatKind = 'server' | 'watcher'

export function beatFile(dir: string, kind: BeatKind, channel: string): string {
    const key = String(channel || '').replace(/[^A-Za-z0-9_-]/g, '')
    const stem = kind === 'server' ? 'slack-alive' : 'slack-watcher'
    return path.join(dir, `${stem}${key ? `-${key}` : ''}.json`)
}

export function writeBeat(dir: string, kind: BeatKind, channel: string, pid: number): void {
    const file = beatFile(dir, kind, channel)
    try {
        // Written aside and renamed, so a reader can never catch it empty
        // mid-write and conclude the process has stopped.
        const temp = `${file}.${pid}.tmp`
        fs.writeFileSync(temp, JSON.stringify({ pid, channel, at: Date.now() }))
        fs.renameSync(temp, file)
    } catch {
        // A heartbeat that cannot be written must not take its process down.
    }
}

export function readBeat(dir: string, kind: BeatKind, channel: string): Beat | null {
    try {
        const beat = JSON.parse(fs.readFileSync(beatFile(dir, kind, channel), 'utf8'))
        if (typeof beat?.at !== 'number') return null
        return { pid: Number(beat.pid) || 0, at: beat.at, channel: beat.channel }
    } catch {
        return null
    }
}

/** How a heartbeat reads to a person: fresh, stale, or never seen. */
export function beatHealth(beat: Beat | null, opts: { now?: number, staleMs?: number } = {}):
    { alive: boolean, detail: string } {
    const now = opts.now ?? Date.now()
    const staleMs = opts.staleMs ?? 60_000

    if (!beat) return { alive: false, detail: 'not running' }
    const age = now - beat.at
    if (age >= staleMs) {
        return { alive: false, detail: `last seen ${formatUptime(age)} ago (pid ${beat.pid}) — stopped` }
    }
    return { alive: true, detail: `running, pid ${beat.pid}` }
}

export interface StatusRecord {
    /** Timestamp of the Slack message holding this channel's status line. */
    ts: string
    /** What that message currently says. */
    online: boolean
    /** When the session behind it connected. */
    since: number
}

/**
 * Remembers which message is this channel's status line, and what it says.
 *
 * On disk rather than in memory, because the whole point is to survive the
 * restart -- an in-memory timestamp would post a fresh message every time,
 * which is the behaviour this exists to avoid. Keyed by channel so two
 * projects on one machine do not fight over one line.
 */
export class StatusStore {
    readonly file: string

    constructor(dir: string, channel: string) {
        this.file = path.join(dir, `slack-status${statusSuffix(channel)}.json`)
    }

    read(): StatusRecord | null {
        return readStatusFile(this.file)
    }

    write(record: StatusRecord): void {
        try {
            fs.writeFileSync(this.file, JSON.stringify(record))
        } catch {
            // Losing this costs one duplicated status message on the next
            // start, which is not worth failing a startup over.
        }
    }

    clear(): void {
        try { fs.rmSync(this.file) } catch { /* already gone */ }
    }
}

function statusSuffix(channel: string): string {
    const key = String(channel || '').replace(/[^A-Za-z0-9_-]/g, '')
    return key ? `-${key}` : ''
}

function readStatusFile(file: string): StatusRecord | null {
    try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (typeof saved?.ts !== 'string' || !saved.ts) return null
        return {
            ts: saved.ts,
            online: saved.online !== false,
            since: Number(saved.since) || 0,
        }
    } catch {
        return null
    }
}

/**
 * Channels whose status line still claims to be online but whose server has
 * stopped beating.
 *
 * The offline line is normally written by the process that is shutting down,
 * which covers a session being closed -- but not a force-kill, a crash, or the
 * machine losing power. In those cases nothing runs, and the channel keeps
 * saying "connected" indefinitely. That is the worst failure this has: a green
 * line that is wrong is more damaging than no line at all, because it is the
 * one thing someone checks before deciding the silence means Claude is busy.
 *
 * So no process is trusted to announce its own death. Any *live* server sweeps
 * for abandoned lines and corrects them -- they all share this directory, so
 * whichever session is running can clean up after the ones that are not.
 *
 * A status file with no heartbeat beside it counts as abandoned: only a
 * version that writes heartbeats writes status files, so the absence means the
 * server is gone rather than that it is old.
 */
export function findAbandoned(dir: string, opts: {
    now?: number
    staleMs?: number
    skip?: string
} = {}): { channel: string, status: StatusRecord }[] {
    const now = opts.now ?? Date.now()
    const staleMs = opts.staleMs ?? 60_000
    const skip = String(opts.skip || '').replace(/[^A-Za-z0-9_-]/g, '')

    let names: string[]
    try {
        names = fs.readdirSync(dir)
    } catch {
        return []
    }

    const out: { channel: string, status: StatusRecord }[] = []

    for (const name of names) {
        const found = /^slack-status-([A-Za-z0-9_-]+)\.json$/.exec(name)
        if (!found) continue

        const channel = found[1]
        if (channel === skip) continue

        const status = readStatusFile(path.join(dir, name))
        if (!status || !status.online) continue

        let beatAt = 0
        try {
            const beat = JSON.parse(fs.readFileSync(path.join(dir, `slack-alive-${channel}.json`), 'utf8'))
            beatAt = Number(beat?.at) || 0
        } catch {
            beatAt = 0 // no heartbeat at all: the server is gone
        }

        if (now - beatAt >= staleMs) out.push({ channel, status })
    }

    return out
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
