/**
 * A live progress checklist, kept to one message in the channel.
 *
 * A long job posted step by step turns a channel into a scroll of
 * half-finished thoughts nobody reads twice. The same job as a checklist that
 * rewrites itself in place is one message you can glance at: what is done,
 * what is happening now, what is still to come.
 *
 * The rendering is here rather than in webhook.ts because it is the part worth
 * testing, and webhook.ts opens a socket the moment it is imported.
 */

export type StepStatus = 'pending' | 'active' | 'done' | 'failed' | 'skipped'

export interface Step {
    text: string
    status: StepStatus
}

export interface Board {
    title?: string
    steps: Step[]
    footer?: string
}

/**
 * Pending and active share an icon deliberately. The difference between "not
 * started" and "running" is carried by the bold on the active line, which
 * reads at a glance; two similar-but-different icons do not.
 */
export const ICON: Record<StepStatus, string> = {
    pending: '⏳',
    active: '⏳',
    done: '✅',
    failed: '❌',
    skipped: '⏭️',
}

const STATUSES = new Set<string>(Object.keys(ICON))

export function isStatus(value: unknown): value is StepStatus {
    return typeof value === 'string' && STATUSES.has(value)
}

/**
 * Accept either a plain list of strings or a list of `{text, status}`.
 *
 * The string form is what a first call almost always wants -- every step
 * pending -- and making the caller spell that out for each entry is friction
 * with no payoff.
 */
export function normalizeSteps(input: unknown): Step[] {
    if (!Array.isArray(input)) return []

    const steps: Step[] = []
    for (const raw of input) {
        if (typeof raw === 'string') {
            if (raw.trim()) steps.push({ text: raw.trim(), status: 'pending' })
            continue
        }
        if (raw && typeof raw === 'object') {
            const text = String((raw as any).text ?? '').trim()
            if (!text) continue
            const status = (raw as any).status
            steps.push({ text, status: isStatus(status) ? status : 'pending' })
        }
    }
    return steps
}

export interface Patch {
    /** A 0-based index, or a substring of the step's text. */
    step: number | string
    status?: StepStatus
    text?: string
}

/**
 * Apply patches to a board's steps, returning a new list.
 *
 * A patch that matches nothing is reported rather than ignored: silently
 * dropping it would leave the board looking stuck while the work moved on,
 * which is worse than an error, because it looks like the job hung.
 */
export function applyPatches(
    steps: Step[], patches: Patch[]
): { steps: Step[], missed: (number | string)[] } {
    const next = steps.map((s) => ({ ...s }))
    const missed: (number | string)[] = []

    for (const patch of patches) {
        if (!patch || patch.step === undefined || patch.step === null) continue

        let index = -1
        if (typeof patch.step === 'number') {
            index = Number.isInteger(patch.step) ? patch.step : -1
        } else {
            const needle = String(patch.step).toLowerCase()
            index = next.findIndex((s) => s.text.toLowerCase().includes(needle))
        }

        if (index < 0 || index >= next.length) {
            missed.push(patch.step)
            continue
        }
        if (isStatus(patch.status)) next[index].status = patch.status
        if (typeof patch.text === 'string' && patch.text.trim()) {
            next[index].text = patch.text.trim()
        }
    }

    return { steps: next, missed }
}

/**
 * Advance the board: whatever is `active` becomes `done`, and the first
 * `pending` step after it becomes `active`.
 *
 * This is the call a loop actually wants between stages, and it removes the
 * commonest way to get a board wrong -- marking a step done and forgetting to
 * start the next one, leaving the checklist looking stalled.
 */
export function advance(steps: Step[]): Step[] {
    const next = steps.map((s) => ({ ...s }))
    for (const step of next) if (step.status === 'active') step.status = 'done'
    const upcoming = next.find((s) => s.status === 'pending')
    if (upcoming) upcoming.status = 'active'
    return next
}

/** mrkdwn already: the caller must not run this through the converter again. */
export function renderBoard(board: Board): string {
    const lines: string[] = []

    if (board.title && board.title.trim()) lines.push(`*${board.title.trim()}*`)

    for (const step of board.steps) {
        // Bold on the running step is what separates it from the ones waiting.
        const label = step.status === 'active' ? `*${step.text}*` : step.text
        lines.push(`${ICON[step.status]} ${label}`)
    }

    if (board.steps.length === 0) lines.push('_no steps_')
    if (board.footer && board.footer.trim()) lines.push('', board.footer.trim())

    return lines.join('\n')
}

/** How the board reads back to Claude, so it knows where the job stands. */
export function summarize(steps: Step[]): string {
    const count = (status: StepStatus) => steps.filter((s) => s.status === status).length
    const parts = [`${count('done')}/${steps.length} done`]
    if (count('failed')) parts.push(`${count('failed')} failed`)
    if (count('skipped')) parts.push(`${count('skipped')} skipped`)
    const running = steps.find((s) => s.status === 'active')
    if (running) parts.push(`now: ${running.text}`)
    return parts.join(', ')
}

/**
 * The boards this session has posted, so a caller can move one step without
 * resending the whole checklist.
 *
 * Memory only, and bounded. It is a convenience over a message that already
 * exists in Slack, not a record of anything: if the process restarts, the
 * caller is told to send the full list again rather than being handed a board
 * that has quietly lost its history.
 */
export class ProgressStore {
    private boards = new Map<string, Board>()

    constructor(private readonly limit = 50) { }

    private static key(channel: string, ts: string): string {
        return `${channel}:${ts}`
    }

    get(channel: string, ts: string): Board | undefined {
        return this.boards.get(ProgressStore.key(channel, ts))
    }

    set(channel: string, ts: string, board: Board): void {
        const key = ProgressStore.key(channel, ts)
        // Re-inserting moves it to the end, so the eviction below always drops
        // the board nobody has touched for longest.
        this.boards.delete(key)
        this.boards.set(key, board)

        while (this.boards.size > this.limit) {
            const oldest = this.boards.keys().next().value
            if (oldest === undefined) break
            this.boards.delete(oldest)
        }
    }

    get size(): number {
        return this.boards.size
    }
}
