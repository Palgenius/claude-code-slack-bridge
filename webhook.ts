import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { App, LogLevel } from '@slack/bolt'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ErrorCode,
    McpError
} from '@modelcontextprotocol/sdk/types.js'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { Inbox, mentionsBot, stripMention, isFromPerson, rotateIfLarge } from './inbox.js'
import { uploadFile, createCanvas, postMessage, updateMessage, react } from './slackRich.js'
import { findTranscript, TranscriptTailer } from './transcript.js'
import { TurnTracker, renderTurn, type ToolDetail } from './turn.js'
import {
    ProgressStore, normalizeSteps, applyPatches, advance,
    renderBoard, summarize, type Step,
} from './progress.js'
import { StatusStore, renderPresence, projectName, findAbandoned } from './presence.js'

// These files used to be written with a bare relative path, which put them in
// whatever directory the session happened to start in rather than next to the
// server. Anchored to this file instead.
const HERE = path.dirname(fileURLToPath(import.meta.url))
const LOG_FILE = path.join(HERE, 'slack-debug.log')
const LOG_MAX_BYTES = 4 * 1024 * 1024
/**
 * This server's own channel, and its inbox.
 *
 * Every project points at the same `webhook.ts`, so without the channel in the
 * name every project shared one inbox and one cursor -- and whichever session
 * called `check_slack_inbox` first read the others' messages and marked them
 * read. See the Inbox constructor.
 */
const OWN_CHANNEL = process.env.SLACK_CHANNEL_ID || ''
const inbox = new Inbox(HERE, OWN_CHANNEL)
const boards = new ProgressStore()

/**
 * A heartbeat file, so the mention watcher can tell this session is still alive.
 *
 * Windows has no process-group kill: when a Claude session dies, nothing
 * signals its descendants, and the spawn chain is five processes deep
 * (claude -> cmd -> npx -> cmd -> tsx -> node). The only thing that reaches
 * the bottom is stdin closing, and that only works for a process that is
 * *reading* stdin -- this server is, through the MCP transport, which is why
 * it now exits with its session.
 *
 * `watch-mentions.mjs` is not: it runs with stdin at /dev/null and polls on a
 * timer, so nothing ever tells it to stop and every session used to leave one
 * behind, still polling and still downloading attachments. It watches this
 * file instead and exits when the beat stops.
 *
 * Never deleted on the way out, deliberately: a missing file would otherwise
 * be ambiguous between "the server stopped" and "no server has ever run for
 * this channel". Letting it go stale says the first unambiguously.
 */
const ALIVE_FILE = path.join(
    HERE, `slack-alive${OWN_CHANNEL ? `-${OWN_CHANNEL.replace(/[^A-Za-z0-9_-]/g, '')}` : ''}.json`)
const ALIVE_INTERVAL_MS = 15_000
let aliveTimer: NodeJS.Timeout | undefined

/**
 * The channel's status line: one message saying whether anything is listening.
 *
 * Rewritten rather than reposted, and the timestamp is kept on disk so a
 * restart edits the same message instead of adding another. Off with
 * SLACK_ANNOUNCE=0 for a channel where it is not wanted.
 */
const status = new StatusStore(HERE, OWN_CHANNEL)
const PROJECT = projectName()
const ANNOUNCE = process.env.SLACK_ANNOUNCE !== '0' && Boolean(OWN_CHANNEL)
const connectedAt = Date.now()

async function announce(online: boolean) {
    if (!ANNOUNCE) return

    const text = renderPresence({
        project: PROJECT, online, since: connectedAt,
        ...(online ? {} : { until: Date.now() }),
    })

    const existing = status.read()
    if (existing) {
        const edited = await updateMessage({
            token: token(), channel: OWN_CHANNEL, ts: existing.ts, text, mrkdwn: false,
        })
        if (edited.ok) {
            status.write({ ts: existing.ts, online, since: connectedAt })
            return
        }
        // Usually the message was deleted, or this is a different channel from
        // the one the timestamp was saved for. Fall through and post a new one.
        diskLog(`status edit failed (${edited.detail}); posting a fresh line`)
    }

    // Never post a fresh "offline" line: there is nothing useful in announcing
    // a departure nobody saw arrive, and a shutdown should not leave litter.
    if (!online) return

    const posted = await postMessage({
        token: token(), channel: OWN_CHANNEL, text, mrkdwn: false,
    })
    if (posted.ok && posted.id) status.write({ ts: posted.id, online: true, since: connectedAt })
    else diskLog(`status post failed: ${posted.detail}`)
}

/**
 * Correct any channel whose line still says "connected" but whose server is
 * gone.
 *
 * No process is trusted to announce its own death: a force-kill, a crash or a
 * power cut runs no handler at all, and the channel then claims to be
 * listening indefinitely. A green line that is wrong is worse than no line,
 * because it is the one thing somebody checks before deciding that silence
 * means Claude is busy rather than absent.
 *
 * Every server shares this directory, so whichever session happens to be
 * running cleans up after the ones that are not -- including for projects it
 * knows nothing about.
 */
async function sweepAbandoned() {
    if (!ANNOUNCE) return

    for (const { channel, status: record } of findAbandoned(HERE, { skip: OWN_CHANNEL })) {
        const text = renderPresence({
            project: '', online: false,
            since: record.since || Date.now(),
            until: Date.now(),
        })
        const edited = await updateMessage({
            token: token(), channel, ts: record.ts, text, mrkdwn: false,
        })
        // Recorded either way: a line that cannot be edited (deleted message,
        // lost scope) must not be retried every fifteen seconds forever.
        new StatusStore(HERE, channel).write({ ...record, online: false })
        diskLog(`swept abandoned status line for ${channel}: ${edited.detail}`)
    }
}

function beat() {
    try {
        // Written to one side and renamed, so a reader can never catch the
        // file empty mid-write and mistake it for a server that has stopped.
        const temp = `${ALIVE_FILE}.${process.pid}.tmp`
        fs.writeFileSync(temp, JSON.stringify({
            pid: process.pid, channel: OWN_CHANNEL, at: Date.now(),
        }))
        fs.renameSync(temp, ALIVE_FILE)
    } catch {
        // A heartbeat that cannot be written must not take the bridge down.
    }
}

/**
 * Inboxes for channels that are not ours, opened as they are needed.
 *
 * Slack hands each message to one randomly chosen connection, so a server
 * regularly receives messages for a channel another session owns. Writing them
 * to that channel's inbox instead of dropping them is what stops them being
 * lost -- the shared filesystem does the routing the socket would not.
 */
const foreignInboxes = new Map<string, Inbox>()
function inboxFor(channel: string): Inbox {
    let box = foreignInboxes.get(channel)
    if (!box) {
        box = new Inbox(HERE, channel)
        foreignInboxes.set(channel, box)
    }
    return box
}

/**
 * The last message that asked for something, waiting for a turn to claim it.
 *
 * Claude Code never tells the server "I am starting work on that" -- the only
 * evidence is the transcript. So the mention is held here, and the next turn
 * that begins takes it: that is what lets the live card go into the asker's
 * own thread and the 👀 land on their message.
 */
let awaitingPickup: { channel: string, ts: string, thread: string } | null = null

/**
 * Every line is tagged with the process and channel that wrote it.
 *
 * One log file is shared by every server on this machine -- one per project,
 * plus any orphan still running -- and three processes interleaving into it
 * with no way to tell them apart is why this file reads as noise. The pid also
 * makes an orphan identifiable directly from the log rather than by walking
 * the process tree.
 */
function diskLog(message: string) {
    try {
        rotateIfLarge(LOG_FILE, LOG_MAX_BYTES)
        const tag = `${process.pid}${OWN_CHANNEL ? ` ${OWN_CHANNEL}` : ''}`
        fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [${tag}] ${message}\n`)
    } catch {
        // Logging must never be the thing that kills the bridge.
    }
}

process.on('uncaughtException', (err) => {
    diskLog(`[Process] Uncaught Exception: ${err}`);
});
process.on('unhandledRejection', (reason) => {
    diskLog(`[Process] Unhandled Rejection: ${reason}`);
});

// Resolved from auth.test at startup so the bot is not hardcoded. The env var
// is an override for the case where that call cannot be reached.
let botUserId = process.env.SLACK_BOT_USER_ID || ''

/**
 * Say which token is missing, once, at startup.
 *
 * Without this the first symptom is an `invalid_auth` on a tool call, or a
 * socket that simply never connects -- neither of which names the variable
 * that was left out of the config.
 */
for (const name of ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'] as const) {
    const value = process.env[name]
    if (!value) {
        diskLog(`CONFIG: ${name} is not set — check the env block of the mcpServers entry`)
        console.error(`[slack-channel] ${name} is not set; the bridge cannot work without it`)
    } else if (name === 'SLACK_BOT_TOKEN' && !value.startsWith('xoxb-')) {
        diskLog('CONFIG: SLACK_BOT_TOKEN does not start with xoxb- — that is the bot token, not the app token')
    } else if (name === 'SLACK_APP_TOKEN' && !value.startsWith('xapp-')) {
        diskLog('CONFIG: SLACK_APP_TOKEN does not start with xapp- — Socket Mode needs the app-level token')
    }
}

const token = () => process.env.SLACK_BOT_TOKEN || ''

// Create the MCP server and declare it as a channel
const mcp = new Server(
    { name: 'webhook', version: '0.0.1' },
    {
        // this key is what makes it a channel — Claude Code registers a listener for it
        capabilities: {
            experimental: { 'claude/channel': {} },
            tools: {}
        },
        // added to Claude's system prompt so it knows how to handle these events
        instructions: [
            'Events from the webhook channel arrive as <channel source="webhook" ...>.',
            'Reply to the user in Slack with `send_slack_message`, using the `channel` ID from the incoming message metadata.',
            'If the incoming message carries a `thread_ts`, pass it back so the reply lands in the same thread rather than at the top of the channel.',
            'If this session was NOT started with --channels those events never arrive — call `check_slack_inbox` to read messages instead. Messages in a channel are collected only when they @mention the bot; every direct message is collected.',
            'For work with more than two or three steps, open a `slack_progress` board first and advance it as you go: it is one message that rewrites itself, and it is far easier to follow than a run of progress replies.',
            // Without the watcher, a Slack message is written to the inbox
            // correctly and then nothing ever surfaces it: the session sees
            // silence that is indistinguishable from nobody having written.
            // The command is spelled out in full because one that has to be
            // assembled by hand is one that does not get run.
            'IMPORTANT — inbound delivery needs a watcher, and it does not start itself.',
            'Start it early in the session with the **Monitor** tool and `persistent: true`, which is the only mechanism that survives a whole session:',
            `Monitor({ command: 'node "${path.join(HERE, 'watch-mentions.mjs').replace(/\\/g, '/')}" --config \\'${path.join(process.cwd(), '.mcp.json').replace(/\\/g, '/')}\\'', description: 'Slack @mentions for this project', persistent: true, timeout_ms: 3600000 })`,
            'Do NOT start it with Bash run_in_background, and do NOT use a Monitor without `persistent: true`: both are bounded (10 minutes and 5 minutes respectively) and the watcher polls forever, so it is killed mid-session and inbound goes silently dead. That has already happened three times.',
            'It should print `watching for @… in C…`; a WARNING block instead means it is reading the wrong inbox.',
            'If one is already running for this session, do not start a second.',
            'Until it runs, incoming Slack messages pile up unread and this session will never hear about them — `check_slack_inbox` is the manual fallback.',
        ].join(' '),
    },
)

// Declare the Slack tools so Claude knows they exist
mcp.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: 'send_slack_message',
                description: 'Send a message to a Slack channel. Use this to reply to webhook channel incoming messages from Slack. Returns the message timestamp (ts) — pass it to update_slack_message to rewrite this message later, which is how a progress or "working on it" marker is kept to one line instead of many.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        channel: {
                            type: 'string',
                            description: 'The Slack channel ID to send the message to (e.g. C0AMZUV0JTZ)'
                        },
                        text: {
                            type: 'string',
                            description: 'The reply, written as ordinary markdown. It is converted to Slack formatting for you — write **bold**, `code`, fenced blocks and [links](url) normally. A message over Slack\'s length limit is split across several posts rather than truncated.'
                        },
                        thread_ts: {
                            type: 'string',
                            description: 'Reply inside a thread. Pass the thread_ts from the incoming message so the answer sits under the question instead of at the top of the channel. Omit only when starting a new topic.'
                        }
                    },
                    required: ['channel', 'text']
                }
            },
            {
                name: 'update_slack_message',
                description: 'Rewrite a message already posted, given its timestamp from send_slack_message. Use it to keep a live status marker on one line: post "working on X", then update it as the work moves and once more when it is done. Far better than posting a new message per step. Only messages this bot posted can be rewritten.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        channel: {
                            type: 'string',
                            description: 'The channel the message is in — must match where it was posted'
                        },
                        ts: {
                            type: 'string',
                            description: 'Timestamp of the message to rewrite, as returned by send_slack_message'
                        },
                        text: {
                            type: 'string',
                            description: 'The replacement text, in full — this is a rewrite, not an append. Ordinary markdown; it is converted for you.'
                        }
                    },
                    required: ['channel', 'ts', 'text']
                }
            },
            {
                name: 'send_slack_image',
                description: 'Upload a local image or file into a Slack channel, so it appears inline rather than as a link. Use for screenshots, diagrams and charts. The path must be a file on this machine.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        channel: {
                            type: 'string',
                            description: 'The Slack channel ID to upload into (e.g. C0AMZUV0JTZ)'
                        },
                        file_path: {
                            type: 'string',
                            description: 'Absolute path to the file on this machine'
                        },
                        title: {
                            type: 'string',
                            description: 'Title shown above the file. Defaults to the filename.'
                        },
                        comment: {
                            type: 'string',
                            description: 'Optional message posted with the file, explaining what it shows.'
                        },
                        thread_ts: {
                            type: 'string',
                            description: 'Upload into a thread rather than the channel root.'
                        }
                    },
                    required: ['channel', 'file_path']
                }
            },
            {
                name: 'slack_progress',
                description: 'A live checklist in Slack, kept to one message that rewrites itself as the work moves. Call once with `steps` to post the board and get back a `ts`; call again with that `ts` and `update` to change a step. Use it for any job with several stages — it replaces a run of "doing X now" messages with one line per step that people can glance at. Statuses: pending, active (the one running now), done, failed, skipped.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        channel: {
                            type: 'string',
                            description: 'The Slack channel ID the board lives in'
                        },
                        ts: {
                            type: 'string',
                            description: 'Timestamp of an existing board, as returned by the first call. Omit to create a new one.'
                        },
                        title: {
                            type: 'string',
                            description: 'Heading above the checklist, e.g. "Deploy". Optional.'
                        },
                        steps: {
                            type: 'array',
                            description: 'The full checklist. Give plain strings to start every step pending, or objects {text, status} to set them explicitly. Required when creating; on an existing board this replaces the list outright.',
                            items: {
                                oneOf: [
                                    { type: 'string' },
                                    {
                                        type: 'object',
                                        properties: {
                                            text: { type: 'string' },
                                            status: { type: 'string', enum: ['pending', 'active', 'done', 'failed', 'skipped'] }
                                        },
                                        required: ['text']
                                    }
                                ]
                            }
                        },
                        update: {
                            type: 'array',
                            description: 'Change individual steps without resending the list. Each entry is {step, status, text}, where `step` is a 0-based index or any substring of that step\'s text.',
                            items: {
                                type: 'object',
                                properties: {
                                    step: { description: '0-based index, or a substring of the step text' },
                                    status: { type: 'string', enum: ['pending', 'active', 'done', 'failed', 'skipped'] },
                                    text: { type: 'string', description: 'Rewrite the step\'s wording too' }
                                },
                                required: ['step']
                            }
                        },
                        advance: {
                            type: 'boolean',
                            description: 'Finish whatever is active and start the next pending step. The usual call between stages — it cannot leave the board looking stalled the way marking a step done and forgetting the next one does.'
                        },
                        footer: {
                            type: 'string',
                            description: 'A line under the checklist — a result, a link, a note. Optional.'
                        },
                        thread_ts: {
                            type: 'string',
                            description: 'Post the board inside a thread. Only used when creating it.'
                        }
                    },
                    required: ['channel']
                }
            },
            {
                name: 'create_slack_canvas',
                description: 'Create a Slack canvas in a channel from markdown. Use for reference material people will come back to — a checklist, a runbook, a spec — rather than a message that scrolls away. Supports headings, lists, checkboxes, bold and code.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        channel: {
                            type: 'string',
                            description: 'The Slack channel ID the canvas belongs to'
                        },
                        title: {
                            type: 'string',
                            description: 'Canvas title. Used when the channel already has a canvas and a standalone one is created instead.'
                        },
                        markdown: {
                            type: 'string',
                            description: 'The canvas body, as markdown'
                        }
                    },
                    required: ['channel', 'title', 'markdown']
                }
            },
            {
                name: 'check_slack_inbox',
                description: 'Read Slack messages that @mentioned the bot and have not been read yet. Use this when the session cannot receive channel notifications (started without --channels), or to catch up on anything missed. Each message comes back with its channel id, so you can reply with send_slack_message.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        peek: {
                            type: 'boolean',
                            description: 'Read without marking the messages as read. Default false.'
                        }
                    }
                }
            }
        ]
    }
})

// Execute the Slack tools when Claude calls them
mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments || {}) as any

    if (request.params.name === 'update_slack_message') {
        if (!args.channel || !args.ts || !args.text) {
            throw new McpError(ErrorCode.InvalidParams, 'channel, ts and text are required')
        }
        const result = await updateMessage({
            token: token(),
            channel: args.channel,
            ts: args.ts,
            text: args.text,
        })
        diskLog(`update_slack_message: ${result.detail}`)
        return {
            content: [{ type: 'text', text: result.ok ? result.detail : `Failed: ${result.detail}` }],
            ...(result.ok ? {} : { isError: true }),
        }
    }

    if (request.params.name === 'send_slack_image') {
        if (!args.channel || !args.file_path) {
            throw new McpError(ErrorCode.InvalidParams, 'channel and file_path are required')
        }
        const result = await uploadFile({
            token: token(),
            channel: args.channel,
            filePath: args.file_path,
            title: args.title,
            comment: args.comment,
            thread_ts: args.thread_ts,
        })
        diskLog(`send_slack_image: ${result.detail}`)
        return {
            content: [{ type: 'text', text: result.ok ? result.detail : `Failed: ${result.detail}` }],
            ...(result.ok ? {} : { isError: true }),
        }
    }

    if (request.params.name === 'create_slack_canvas') {
        if (!args.channel || !args.title || !args.markdown) {
            throw new McpError(ErrorCode.InvalidParams, 'channel, title and markdown are required')
        }
        const result = await createCanvas({
            token: token(),
            channel: args.channel,
            title: args.title,
            markdown: args.markdown,
        })
        diskLog(`create_slack_canvas: ${result.detail}`)
        return {
            content: [{ type: 'text', text: result.ok ? `${result.detail} (id ${result.id})` : `Failed: ${result.detail}` }],
            ...(result.ok ? {} : { isError: true }),
        }
    }

    if (request.params.name === 'slack_progress') {
        if (!args.channel) {
            throw new McpError(ErrorCode.InvalidParams, 'channel is required')
        }

        const given = normalizeSteps(args.steps)

        // Creating: one post, and the ts it comes back with is the handle for
        // every later call.
        if (!args.ts) {
            if (given.length === 0) {
                throw new McpError(ErrorCode.InvalidParams,
                    'steps are required to create a board — pass a list of strings, or {text, status} objects')
            }
            const steps = args.advance ? advance(given) : given
            const board = { title: args.title, steps, footer: args.footer }

            const result = await postMessage({
                token: token(),
                channel: args.channel,
                text: renderBoard(board),
                thread_ts: args.thread_ts,
                mrkdwn: false, // renderBoard already emits mrkdwn
            })
            diskLog(`slack_progress create: ${result.detail}`)

            if (!result.ok || !result.id) {
                return {
                    content: [{ type: 'text', text: `Failed to post the progress board: ${result.detail}` }],
                    isError: true,
                }
            }
            boards.set(args.channel, result.id, board)
            return {
                content: [{
                    type: 'text',
                    text: `Progress board posted. ts=${result.id} — pass this back to update it. ${summarize(steps)}`,
                }],
            }
        }

        // Updating: the board is remembered by ts, so a caller can move one
        // step without resending the checklist.
        const remembered = boards.get(args.channel, args.ts)
        let steps: Step[]

        if (given.length > 0) {
            steps = given
        } else if (remembered) {
            steps = remembered.steps
        } else {
            // The process restarted, or this ts belongs to another session's
            // board. Saying so beats rewriting the message with a board that
            // has quietly lost every step before now.
            return {
                content: [{
                    type: 'text',
                    text: `No board is remembered for ts=${args.ts} in ${args.channel} — this server may have restarted since it was posted. Call again with the full \`steps\` list to take it over.`,
                }],
                isError: true,
            }
        }

        const patches = Array.isArray(args.update) ? args.update : []
        const patched = applyPatches(steps, patches)
        steps = args.advance ? advance(patched.steps) : patched.steps

        const board = {
            title: args.title ?? remembered?.title,
            steps,
            footer: args.footer ?? remembered?.footer,
        }

        const result = await updateMessage({
            token: token(),
            channel: args.channel,
            ts: args.ts,
            text: renderBoard(board),
            mrkdwn: false,
        })
        diskLog(`slack_progress update: ${result.detail}`)

        if (!result.ok) {
            return {
                content: [{ type: 'text', text: `Failed to update the progress board: ${result.detail}` }],
                isError: true,
            }
        }
        boards.set(args.channel, args.ts, board)

        const missed = patched.missed.length > 0
            ? ` (no step matched ${patched.missed.map((m) => JSON.stringify(m)).join(', ')})`
            : ''
        return {
            content: [{ type: 'text', text: `Board updated: ${summarize(steps)}${missed}` }],
            ...(patched.missed.length > 0 ? { isError: true } : {}),
        }
    }

    if (request.params.name === 'check_slack_inbox') {
        const peek = Boolean(args.peek)
        const unread = inbox.unread()

        if (!peek) inbox.markRead(unread)
        diskLog(`check_slack_inbox: ${unread.length} unread${peek ? ' (peek)' : ''}`)

        if (unread.length === 0) {
            return { content: [{ type: 'text', text: 'No unread Slack mentions.' }] }
        }
        return {
            content: [{
                type: 'text',
                text: unread.map((m) => {
                    // thread_ts is handed back so a reply can go into the same
                    // thread; without it every answer lands in the channel root
                    // and the question it belongs to is two screens up.
                    const head = [
                        `[${m.received_at}]`,
                        `channel=${m.channel}`,
                        `user=${m.user}`,
                        m.thread_ts ? `thread_ts=${m.thread_ts}` : `thread_ts=${m.ts}`,
                        m.channel_type === 'im' ? '(direct message)' : '',
                    ].filter(Boolean).join(' ')

                    const files = (m.files || [])
                        .map((f) => `  attachment: ${f.name || f.id} (${f.mimetype || 'unknown'})`)
                        .join('\n')

                    return [head, m.text, files].filter(Boolean).join('\n')
                }).join('\n\n')
            }]
        }
    }

    if (request.params.name !== 'send_slack_message') {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`)
    }

    const { channel, text } = args
    if (!channel || !text) {
        throw new McpError(ErrorCode.InvalidParams, 'channel and text are required')
    }

    // Routed through slackRich rather than app.client so it comes back with the
    // timestamp -- update_slack_message needs it -- and so an over-long message
    // is truncated instead of being rejected whole by Slack.
    const result = await postMessage({
        token: token(),
        channel,
        text,
        thread_ts: args.thread_ts,
    })
    diskLog(`send_slack_message: ${result.detail}`)

    if (!result.ok) {
        return {
            content: [{ type: 'text', text: `Failed to send to Slack: ${result.detail}` }],
            isError: true,
        }
    }
    return {
        content: [{
            type: 'text',
            text: `Message successfully sent to Slack. ts=${result.id} — pass this to update_slack_message to rewrite it.`,
        }],
    }
})

// Connect to Claude Code over stdio (Claude Code spawns this process)
// We need to wait for MCP connection before starting Slack to guarantee we don't miss events
await mcp.connect(new StdioServerTransport())

// Initialize the Slack Bolt App in Socket Mode
const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
    // Bolt requires signingSecret even in Socket Mode, we provide a fallback dummy
    signingSecret: process.env.SLACK_SIGNING_SECRET || 'dummy-secret',
    // MUST write logs to stderr, or else it corrupts the MCP stdio protocol
    logger: {
        debug: (...msgs) => console.error('[Slack DEBUG]', ...msgs),
        info: (...msgs) => console.error('[Slack INFO]', ...msgs),
        warn: (...msgs) => console.error('[Slack WARN]', ...msgs),
        error: (...msgs) => console.error('[Slack ERROR]', ...msgs),
        setLevel: () => { },
        getLevel: () => LogLevel.DEBUG,
        setName: () => { }
    }
})

/**
 * Let go of the Slack socket when the session that spawned us is gone.
 *
 * Slack load-balances Socket Mode across every connected client, so a server
 * left running after its Claude session exits still gets its share of the
 * messages -- and writes them to a pipe with nothing on the other end. They
 * are not delivered anywhere and nothing reports it; the integration guide's
 * advice was to go and find the orphan by hand.
 *
 * stdin closing is the reliable signal. Claude Code spawns this over stdio, so
 * the pipe ending means the parent is gone, whether it exited cleanly or not.
 */
let stopping = false
let streamTimer: NodeJS.Timeout | undefined

async function shutdown(why: string) {
    if (stopping) return
    stopping = true
    diskLog(`Shutting down: ${why}`)
    if (streamTimer) clearInterval(streamTimer)
    // Stopped, not deleted: the watcher reads staleness, not absence.
    if (aliveTimer) clearInterval(aliveTimer)

    // Flip the channel's status line to offline before going. Bounded, because
    // this runs while the session is already tearing down and a hung request
    // must not hold the process open.
    try {
        await Promise.race([
            announce(false),
            new Promise((done) => setTimeout(done, 3000)),
        ])
    } catch (error) {
        diskLog(`could not set the status line offline: ${error}`)
    }

    try {
        await app.stop()
    } catch (error) {
        diskLog(`Slack app did not stop cleanly: ${error}`)
    }
    process.exit(0)
}

process.stdin.on('end', () => void shutdown('stdin closed — the Claude session has exited'))
process.stdin.on('close', () => void shutdown('stdin closed — the Claude session has exited'))
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
mcp.onclose = () => void shutdown('the MCP transport closed')

// Listen for all messages in channels the bot is invited to
app.message(async ({ message }) => {
    // A direct message is addressed to the bot by definition: there is nobody
    // else in the conversation. Requiring an @mention in a DM would be asking
    // someone to say a name into an empty room.
    const isDirect = (message as any).channel_type === 'im'

    // Whether this message is for the channel this server was configured for.
    // DMs are always ours -- that setting is about which channel to listen in,
    // and a DM is not one.
    //
    // This used to `return` here, silently, which was the worst possible place
    // to decide it: Slack hands each message to one randomly chosen
    // connection, so with two projects running, roughly half of each one's
    // messages arrived at the other server and were discarded with no record
    // anywhere. The filtering below runs first now, and what survives it is
    // written to the inbox of the channel it belongs to.
    const ours = !OWN_CHANNEL || String(message.channel) === OWN_CHANNEL || isDirect

    // A message with a file attached arrives as `file_share`, and a reply also
    // posted to the channel as `thread_broadcast`. Both are a person typing.
    // Everything else carrying a subtype is not: joins, huddles, edits,
    // deletions, the bot's own posts. The first version of this skipped every
    // subtype, which silently threw away every message with an image on it.
    const subtype = (message as any).subtype
    if (!isFromPerson(subtype)) {
        // Only for our own channel. Every server sees every channel's events,
        // and the live card's own edits come back as `message_changed`, so
        // logging all of them buries everything else.
        if (ours) diskLog(`Ignored subtype "${subtype}" in ${message.channel}`)
        return
    }

    const author = (message as any).user || 'unknown'
    if (author === botUserId) return // never react to ourselves

    const text = (message as any).text || ''

    // The channel is also somewhere people talk to each other. Only what is
    // addressed to the bot should reach Claude. A DM always is.
    if (!isDirect && !mentionsBot(text, botUserId)) {
        if (ours) diskLog(`Ignored (no mention) from ${author}: ${text.slice(0, 40)}`)
        return
    }

    // Only what is needed to fetch or name the file later — the raw Slack file
    // object is large and mostly irrelevant.
    const files = (Array.isArray((message as any).files) ? (message as any).files : [])
        .map((f: any) => ({
            id: f.id,
            name: f.name,
            mimetype: f.mimetype,
            size: f.size,
            url_private_download: f.url_private_download,
        }))

    // A message already in a thread carries the parent's ts; one that is not
    // becomes the parent if the reply threads off it. Either way this is where
    // the answer belongs.
    const threadTs = String((message as any).thread_ts || (message as any).ts)

    const entry = {
        ts: (message as any).ts,
        channel: String(message.channel),
        user: author,
        text: stripMention(text, botUserId),
        received_at: new Date().toISOString(),
        thread_ts: threadTs,
        ...(isDirect ? { channel_type: 'im' } : {}),
        ...(files.length > 0 ? { files } : {}),
    }
    // Not for us: Slack routed another session's message here. Write it to
    // that channel's inbox so the session that owns it finds it on its next
    // `check_slack_inbox`, and stop. Nothing else here applies -- the live
    // view, the notification and the pickup all belong to that other session.
    //
    // This is the shared filesystem standing in for the routing the socket
    // does not do. It is not instant for the other session, but it is the
    // difference between late and lost.
    if (!ours) {
        inboxFor(entry.channel).append(entry)
        diskLog(`ROUTED -> ${entry.channel} (not ours) from ${entry.user}: ${entry.text.slice(0, 40)}`)
        return
    }

    inbox.append(entry)
    diskLog(`INBOX <- ${entry.user}${isDirect ? ' (dm)' : ''}: ${entry.text.slice(0, 60)}`)

    // Held for the live view to claim when work on it starts.
    awaitingPickup = { channel: entry.channel, ts: entry.ts, thread: entry.thread_ts }

    // Still attempted, so this works natively the moment a session does have
    // --channels. Without the flag Claude Code accepts the notification and
    // drops it, which is the whole reason the inbox above exists.
    try {
        await mcp.notification({
            method: 'notifications/claude/channel',
            params: {
                content: entry.text,  // becomes the body of the <channel> tag
                // these metadata keys become attributes on the <channel> tag
                meta: {
                    channel: entry.channel,
                    user: entry.user,
                    thread_ts: entry.thread_ts,
                    type: 'slack_message'
                },
            },
        })
        diskLog(`Successfully forwarded to MCP! -> ${entry.text.slice(0, 30)}...`)
    } catch (error) {
        // Expected when the pipe is gone (an exited session's orphan). The
        // inbox write above has already happened, so nothing is lost.
        diskLog(`MCP notify failed: ${error}`)
    }
})

// Knowing who we are is what makes mention-filtering possible, so it has to
// happen before the socket opens and the first message can arrive.
if (!botUserId) {
    try {
        const who = await app.client.auth.test()
        botUserId = String(who.user_id || '')
        diskLog(`Bot user id resolved as ${botUserId}`)
    } catch (error) {
        diskLog(`Could not resolve bot user id, mentions cannot be matched: ${error}`)
    }
}

/**
 * Mirror what Claude writes into the channel, line by line.
 *
 * Claude Code has no outbound channel -- `notifications/claude/channel` is
 * Slack -> Claude and has no counterpart -- but it writes the session to a
 * JSONL file as it goes, so following that file gives the same result.
 * Project-agnostic: the session id comes from the environment.
 *
 * OFF unless SLACK_STREAM=1 is set, and deliberately so. This forwards
 * Claude's side of a session to an external service, and Claude's prose
 * quotes files, configuration and command output. transcript.ts drops private
 * reasoning outright and masks credentials, but masking is pattern-matching,
 * not a guarantee -- so switching it on is a decision for whoever owns the
 * workspace, made in their own config, not a default.
 */
/**
 * How far the stream may fall behind before it starts dropping.
 *
 * At one post a second, a queue of 200 is over three minutes of backlog. A
 * busy session writes faster than Slack will accept for as long as it runs, so
 * without a bound the queue grows without limit and the channel ends up
 * narrating something that finished ten minutes ago. Dropping the oldest and
 * saying how many is the honest failure.
 */
const STREAM_QUEUE_MAX = 200

/**
 * How often the live card is rewritten while a turn is running.
 *
 * The elapsed time is part of the card, so it changes on every tick and this
 * interval is the whole cost. `chat.update` allows roughly fifty calls a
 * minute; four seconds keeps it to fifteen, with room for everything else.
 */
const CARD_INTERVAL_MS = 4000

/** `0`/unset says nothing about tools, `1` their names, `detail` a target too. */
function toolDetail(): ToolDetail {
    const value = (process.env.SLACK_STREAM_TOOLS || '0').toLowerCase()
    if (value === 'detail' || value === '2') return 'detail'
    if (value === '1' || value === 'true') return 'name'
    return 'none'
}

function startStreaming(channel: string) {
    const file = findTranscript({ sessionId: process.env.CLAUDE_CODE_SESSION_ID })
    if (!file) {
        diskLog('SLACK_STREAM set but no session transcript found; not streaming')
        return
    }

    const tailer = new TranscriptTailer(file)
    const tracker = new TurnTracker(toolDetail())
    diskLog(`Live view following ${file} (tool detail: ${toolDetail()})`)

    // chat.postMessage is rate limited at roughly one per second per channel,
    // and a single reply can hold several blocks. Queue them and drain at a
    // pace Slack accepts, rather than firing them all and being throttled.
    const queue: { text: string, thread?: string }[] = []
    let dropped = 0
    let draining = false

    // The card being rewritten, the thread this turn lives in, and the message
    // that asked for it.
    let cardTs = ''
    let threadTs: string | undefined
    let trigger: { channel: string, ts: string } | null = null
    let lastCard = ''
    let lastCardAt = 0

    function enqueue(text: string, thread?: string) {
        queue.push({ text, thread })
        while (queue.length > STREAM_QUEUE_MAX) {
            queue.shift()
            dropped++
        }
    }

    async function drain() {
        if (draining) return
        draining = true
        try {
            while (queue.length > 0 && !stopping) {
                const item = queue.shift() as { text: string, thread?: string }
                const r = await postMessage({
                    token: token(), channel, text: item.text, thread_ts: item.thread,
                })
                if (!r.ok) diskLog(`stream post failed: ${r.detail}`)
                await new Promise((done) => setTimeout(done, 1100))
            }
            if (dropped > 0) {
                diskLog(`stream dropped ${dropped} block(s) to stay within the queue bound`)
                const note = `_…${dropped} block(s) skipped; the session was writing faster than Slack accepts_`
                dropped = 0
                await postMessage({ token: token(), channel, text: note, thread_ts: threadTs })
            }
        } finally {
            draining = false
        }
    }

    /** Rewrite the card, unless nothing has changed since it was last sent. */
    async function paint(text: string, force = false) {
        if (!cardTs) return
        if (!force && text === lastCard) return
        lastCard = text
        lastCardAt = Date.now()
        const r = await updateMessage({ token: token(), channel, ts: cardTs, text, mrkdwn: false })
        if (!r.ok) diskLog(`card update failed: ${r.detail}`)
    }

    async function handle(event: ReturnType<TurnTracker['feed']>[number]) {
        if (event.kind === 'start') {
            // The mention that set this off, if one is waiting. Claimed rather
            // than copied, so a second turn cannot land in the same thread.
            const claim = awaitingPickup
            awaitingPickup = null
            trigger = claim ? { channel: claim.channel, ts: claim.ts } : null
            threadTs = claim && claim.channel === channel ? claim.thread : undefined

            const text = renderTurn(event.turn)
            const posted = await postMessage({
                token: token(), channel, text, thread_ts: threadTs, mrkdwn: false,
            })
            cardTs = posted.ok && posted.id ? posted.id : ''
            lastCard = text
            lastCardAt = Date.now()

            // With no thread of its own the card starts one, so a long turn is
            // a single item in the channel rather than a runaway scroll.
            if (!threadTs && cardTs) threadTs = cardTs

            if (trigger) {
                await react({ token: token(), channel: trigger.channel, ts: trigger.ts, emoji: 'eyes' })
            }
            return
        }

        if (event.kind === 'text') {
            enqueue(event.text, threadTs)
            return
        }

        if (event.kind === 'end') {
            await paint(renderTurn(event.turn), true)
            if (trigger) {
                await react({
                    token: token(), channel: trigger.channel, ts: trigger.ts,
                    emoji: event.turn.errors > 0 ? 'warning' : 'white_check_mark',
                    remove: ['eyes'],
                })
            }
            cardTs = ''
            trigger = null
            return
        }

        // 'activity' waits for the tick below, so a burst of tool calls costs
        // one rewrite rather than twenty.
    }

    streamTimer = setInterval(() => {
        void (async () => {
            let events: ReturnType<TurnTracker['feed']> = []
            try {
                events = tracker.feed(tailer.nextEntries())
            } catch (err) {
                diskLog(`stream read failed: ${err}`)
            }

            for (const event of events) {
                try {
                    await handle(event)
                } catch (err) {
                    diskLog(`live view failed on ${event.kind}: ${err}`)
                }
            }

            // Tick the clock, and show any tool calls that arrived since.
            const running = tracker.current
            if (running && running.phase === 'working' && cardTs
                && Date.now() - lastCardAt >= CARD_INTERVAL_MS) {
                try { await paint(renderTurn(running)) } catch (err) { diskLog(`card tick failed: ${err}`) }
            }

            void drain()
        })()
    }, 1500)
}

// Log startup locally (goes to stderr so it doesn't break StdioServerTransport)
app.start().then(() => {
    diskLog('APP STARTED: ⚡️ Slack Socket Mode Connected Successfully!')
    console.error('⚡️ Slack MCP Receiver is running in Socket Mode!')

    // Tells the mention watcher this session is still here. See ALIVE_FILE.
    beat()
    aliveTimer = setInterval(() => {
        beat()
        // Also clean up after any session that died without saying so.
        void sweepAbandoned().catch((error) => diskLog(`status sweep failed: ${error}`))
    }, ALIVE_INTERVAL_MS)

    // Say so in the channel, so a quiet channel can be told from a dead one.
    void announce(true).catch((error) => diskLog(`status announce failed: ${error}`))
    void sweepAbandoned().catch((error) => diskLog(`status sweep failed: ${error}`))

    const channel = process.env.SLACK_CHANNEL_ID
    if (process.env.SLACK_STREAM === '1' && channel) {
        startStreaming(channel)
    } else if (process.env.SLACK_STREAM === '1') {
        diskLog('SLACK_STREAM=1 but SLACK_CHANNEL_ID is unset; nowhere to stream to')
    }
}).catch((error) => {
    diskLog(`APP FAILED: ${error}`)
    console.error('Failed to start Slack App:', error)
})
