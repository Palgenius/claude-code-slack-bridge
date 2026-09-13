/**
 * Emits one line per new Slack message that @mentions the bot.
 *
 * Claude Code drops `claude/channel` notifications unless its session was
 * started with `--channels`, which the desktop app does not pass. This script
 * is the way round that: run it under a Monitor and every stdout line becomes
 * an event in the session, so a mention in Slack reaches Claude without the
 * flag.
 *
 * It reads two sources, because both can be live at once:
 *
 *   1. slack-inbox.jsonl  — written by the current webhook.ts, already
 *                           filtered to mentions.
 *   2. slack-debug.log    — written by an older webhook.ts still running in
 *                           an existing session. Those instances log the full
 *                           message JSON and filter nothing, so mentions are
 *                           recovered from the log text instead.
 *
 * Reading both matters: Slack load-balances Socket Mode across every connected
 * client, so a message may land on any running instance regardless of which
 * version it is.
 *
 * Usage: node watch-mentions.mjs <botUserId> [--config <mcp.json>] [extraLogPath ...]
 *
 * `--config` points at an .mcp.json holding the bot token, used only to
 * download attachments. The token is read from the file rather than passed as
 * an argument so it never appears in a command line or a process list.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// The bot id is optional: given as the first argument, or resolved from the
// token in --config. Making it optional is what lets the server hand Claude a
// fixed command to run, rather than one that has to be filled in by hand --
// and a command that has to be assembled by hand is one that does not get run.
const argv = process.argv.slice(2)
let BOT = argv.length > 0 && !argv[0].startsWith('-') ? argv.shift() : ''

let CONFIG = ''
let CHANNEL = ''
const EXTRA_LOGS = []
for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') { CONFIG = argv[++i] || ''; continue }
    if (argv[i] === '--channel') { CHANNEL = argv[++i] || ''; continue }
    EXTRA_LOGS.push(argv[i])
}

if (!BOT && !CONFIG) {
    console.error('usage: node watch-mentions.mjs [botUserId] [--channel <C0…>] [--config <mcp.json>] [extraLogPath ...]')
    console.error('       the bot id is resolved from --config when it is not given')
    process.exit(2)
}

// Held in memory only, and never logged or printed.
let botToken = ''
if (CONFIG) {
    try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
        const server = cfg?.mcpServers?.['slack-channel']?.env || {}
        botToken = server.SLACK_BOT_TOKEN || ''
        // The channel too, when it was not given: the config already says
        // which one this project listens to, and one source beats two.
        if (!CHANNEL) CHANNEL = server.SLACK_CHANNEL_ID || ''
    } catch (err) {
        console.error(`[watch-mentions] could not read ${CONFIG}: ${err.message}`)
    }
}

// Ask Slack who we are, rather than making the caller paste an id. Mention
// matching is the whole job, so there is nothing to do without this.
if (!BOT) {
    if (!botToken) {
        console.error('[watch-mentions] no bot id given and no token in --config to resolve one from')
        process.exit(2)
    }
    try {
        const who = await fetch('https://slack.com/api/auth.test', {
            method: 'POST',
            headers: { Authorization: `Bearer ${botToken}` },
        }).then((r) => r.json())
        if (!who?.ok || !who.user_id) throw new Error(who?.error || 'auth.test returned nothing')
        BOT = String(who.user_id)
        console.error(`[watch-mentions] resolved bot id ${BOT} from ${CONFIG}`)
    } catch (err) {
        console.error(`[watch-mentions] could not resolve the bot id: ${err.message}`)
        process.exit(2)
    }
}

const ATTACHMENTS = path.join(HERE, 'attachments')

/**
 * A message with an attachment arrives as subtype `file_share`, and a reply
 * also posted to the channel as `thread_broadcast`. Both are a person typing.
 * Everything else with a subtype — joins, huddles, edits, deletions, the
 * bot's own posts — is not.
 *
 * This started as "skip anything with a subtype", which was wrong: it threw
 * away every message that had a file attached to it.
 */
const HUMAN_SUBTYPES = new Set([undefined, null, '', 'file_share', 'thread_broadcast'])

/**
 * Pull the bytes down so the image can actually be looked at, rather than
 * just named. Needs the `files:read` scope on the bot token; without it Slack
 * answers 403 with an HTML page, so the magic-number check below is what
 * distinguishes a real file from an error page wearing a .png name.
 */
async function download(file) {
    const label = `${file.name || file.id} (${file.mimetype || 'unknown'}, ${Math.round((file.size || 0) / 1024)}KB)`
    if (!file.url_private_download) return `${label} — no download url`
    if (!botToken) return `${label} — not downloaded, no token given (pass --config)`

    try {
        const res = await fetch(file.url_private_download, {
            headers: { Authorization: `Bearer ${botToken}` },
        })
        const buf = Buffer.from(await res.arrayBuffer())
        const type = res.headers.get('content-type') || ''

        if (res.status !== 200 || type.startsWith('text/html')) {
            return `${label} — download refused (HTTP ${res.status}); the bot token needs the files:read scope`
        }

        fs.mkdirSync(ATTACHMENTS, { recursive: true })
        const safe = String(file.name || file.id).replace(/[^A-Za-z0-9._-]/g, '_')
        const dest = path.join(ATTACHMENTS, `${file.id}-${safe}`)
        fs.writeFileSync(dest, buf)
        return `${label} -> ${dest}`
    } catch (err) {
        return `${label} — download failed: ${err.message}`
    }
}

/**
 * One inbox per channel, since every project points at the same server and
 * used to share a single file. The legacy unsuffixed file is read as well, so
 * a watcher started against a channel still picks up anything written before
 * the split -- entries from other channels in it are filtered out below.
 */
const key = CHANNEL.replace(/[^A-Za-z0-9_-]/g, '')
const INBOXES = [
    ...(key ? [path.join(HERE, `slack-inbox-${key}.jsonl`)] : []),
    path.join(HERE, 'slack-inbox.jsonl'),
]
const LOGS = [path.join(HERE, 'slack-debug.log'), ...EXTRA_LOGS]

/**
 * Say so loudly when this is watching a file nothing writes to any more.
 *
 * The inbox used to be one shared `slack-inbox.jsonl` and is now one file per
 * channel. A watcher started before that change keeps polling the old file
 * forever: messages arrive correctly, land in the per-channel file, and the
 * watcher reports nothing -- silence that looks exactly like "no one has said
 * anything". That is precisely how this went unnoticed once already, so it is
 * worth a paragraph of noise on startup.
 */
if (!key) {
    let perChannel = []
    try {
        perChannel = fs.readdirSync(HERE).filter((f) => /^slack-inbox-.+\.jsonl$/.test(f))
    } catch { /* nothing to check against */ }

    if (perChannel.length > 0) {
        console.error(
            `[watch-mentions] WARNING: started without --channel, so this is reading the old shared\n` +
            `                 inbox — but per-channel inboxes exist and are where messages now go:\n` +
            perChannel.map((f) => `                   ${f}`).join('\n') + '\n' +
            `                 You will see nothing until this is restarted with --channel <C0…>.`)
    }
}

/**
 * Stop when the session that started this is gone.
 *
 * Nothing tells this script to exit. Windows has no process-group kill, the
 * spawn chain is five processes deep, and it runs with stdin at /dev/null --
 * so the one signal that does reach a Claude Code child, stdin closing, never
 * arrives here. Every session used to leave a watcher behind, still polling
 * every two seconds and still downloading attachments, for as long as the
 * machine stayed up.
 *
 * The MCP server does exit with its session (its stdin is the MCP transport),
 * so its heartbeat file is a reliable proxy for the session being alive.
 *
 * Only ever acted on after a live beat has been seen: without that, a watcher
 * started before its server -- or for a channel with no server at all -- would
 * exit immediately.
 */
const ALIVE = key ? path.join(HERE, `slack-alive-${key}.json`) : ''

/**
 * How long the server may be absent before this is presumed orphaned.
 *
 * This was sixty seconds, which was far too tight and cost hours of silence.
 * A server restart -- an MCP reconnect, a session restart, a slow machine --
 * leaves a gap easily longer than a minute, and the watcher would exit *on
 * purpose* in the middle of a perfectly alive session. Nothing then brought it
 * back, so inbound simply stopped, and the log showed no error because the
 * exit was deliberate.
 *
 * Ten minutes distinguishes the two cases properly: a restart is seconds, and
 * a session that has genuinely ended never returns. An orphan lingering for a
 * few extra minutes is a far smaller problem than a live session going deaf.
 */
const STALE_MS = 10 * 60_000

/** Logged once when the server goes quiet, so a gap is visible but not noisy. */
let noticedGap = false
let sawHeartbeat = false

/** A gap worth mentioning, well before it is a gap worth quitting over. */
const GAP_NOTICE_MS = 60_000

function sessionGone() {
    if (!ALIVE) return false

    let beat = null
    try {
        beat = JSON.parse(fs.readFileSync(ALIVE, 'utf8'))
    } catch {
        // Missing or unreadable. Treated as maximally old, and handled by the
        // same thresholds below rather than as an instant death sentence.
    }
    const age = beat ? Date.now() - Number(beat.at || 0) : Infinity

    // Healthy.
    if (age < GAP_NOTICE_MS) {
        if (noticedGap) {
            console.error('[watch-mentions] the server is back; still listening')
            noticedGap = false
        }
        sawHeartbeat = true
        return false
    }

    // Quiet, but not long enough to call it. Keep going: the server writes
    // mentions straight to the inbox, so anything that arrives during a
    // restart is still picked up the moment this next polls.
    if (age < STALE_MS) {
        if (!noticedGap) {
            noticedGap = true
            console.error(`[watch-mentions] the server has been quiet for ${Math.round(age / 1000)}s`
                + ` — still listening; will stop only if it stays away`)
        }
        return false
    }

    // Gone long enough that a restart is not the explanation.
    return sawHeartbeat
}

// Only ever read the tail. These files grow without bound and re-reading a
// large log every couple of seconds would be the slowest thing here.
const TAIL_BYTES = 512 * 1024

function readTail(file) {
    try {
        const size = fs.statSync(file).size
        const start = Math.max(0, size - TAIL_BYTES)
        const fd = fs.openSync(file, 'r')
        try {
            const length = size - start
            const buf = Buffer.alloc(length)
            fs.readSync(fd, buf, 0, length, start)
            return buf.toString('utf8')
        } finally {
            fs.closeSync(fd)
        }
    } catch {
        return '' // not created yet, or briefly locked mid-write
    }
}

function mentionsBot(text) {
    return String(text || '').includes(`<@${BOT}>`)
}

function stripMention(text) {
    return String(text || '').split(`<@${BOT}>`).join('').replace(/\s+/g, ' ').trim()
}

/** Mentions already filtered by the current server. */
function fromInbox() {
    const out = []
    for (const line of INBOXES.flatMap((f) => readTail(f).split('\n'))) {
        if (line.trim() === '') continue
        try {
            const m = JSON.parse(line)
            // The legacy shared file can hold other channels' messages.
            if (key && m && m.channel && m.channel !== key) continue
            if (m && m.ts) {
                out.push({
                    ts: String(m.ts),
                    channel: m.channel,
                    user: m.user,
                    text: m.text,
                    thread_ts: m.thread_ts || String(m.ts),
                    channel_type: m.channel_type,
                    files: Array.isArray(m.files) ? m.files : [],
                })
            }
        } catch {
            // A partial last line, or a torn write from two instances
            // appending at once. The next poll sees it complete.
        }
    }
    return out
}

/** Mentions recovered from an older instance's unfiltered debug log. */
function fromLogs() {
    const out = []
    for (const file of LOGS) {
        for (const line of readTail(file).split('\n')) {
            if (!line.includes('Received message event')) continue
            const at = line.indexOf('{')
            if (at === -1) continue
            let msg
            try {
                msg = JSON.parse(line.slice(at))
            } catch {
                continue
            }
            if (!msg || !msg.ts) continue
            if (key && msg.channel && msg.channel !== key) continue
            if (!HUMAN_SUBTYPES.has(msg.subtype)) continue
            if (msg.user === BOT) continue
            // A direct message is addressed to the bot by definition; there is
            // nobody else in the conversation to be talking to.
            const direct = msg.channel_type === 'im'
            if (!direct && !mentionsBot(msg.text)) continue
            out.push({
                ts: String(msg.ts),
                channel: msg.channel,
                user: msg.user,
                text: stripMention(msg.text),
                thread_ts: String(msg.thread_ts || msg.ts),
                channel_type: msg.channel_type,
                files: Array.isArray(msg.files) ? msg.files : [],
            })
        }
    }
    return out
}

function collect() {
    const byTs = new Map()
    // Inbox second so its cleaner copy wins for the same message.
    for (const m of fromLogs()) byTs.set(m.ts, m)
    for (const m of fromInbox()) byTs.set(m.ts, m)
    return byTs
}

// Everything already on disk is history, not news. Without this baseline the
// first poll would replay every past mention as a fresh event.
const seen = new Set(collect().keys())
console.error(`[watch-mentions] watching for @${BOT}${key ? ` in ${key}` : ' (all channels)'}; ${seen.size} existing mention(s) ignored as history`)

async function poll() {
    for (const [ts, m] of collect()) {
        if (seen.has(ts)) continue
        seen.add(ts)
        const body = m.text && m.text !== '' ? m.text : '(no text)'
        // One line per mention. The channel id and thread_ts are included so a
        // reply can go straight back with send_slack_message, into the thread
        // the question was asked in rather than the top of the channel.
        //
        // A multi-line message is emitted as one line with escaped breaks: the
        // Monitor turns each stdout line into an event, so a real newline here
        // would split one message into several unrelated ones.
        const kind = m.channel_type === 'im' ? 'SLACK DM' : 'SLACK MENTION'
        const flat = body.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')
        console.log(`${kind} from ${m.user} in ${m.channel} thread=${m.thread_ts} :: ${flat}`)
        // Lines emitted within 200ms are batched into one notification, so an
        // attachment reads as part of the message rather than a separate one.
        for (const file of m.files || []) {
            console.log(`  ATTACHMENT ${await download(file)}`)
        }
    }
}

// Overlapping runs would double-report: a download can take longer than the
// poll interval, and `seen` is only updated once a message is picked up.
/**
 * Publish our own heartbeat, so `slack_status` can report whether anything is
 * listening. Without it "is Slack working?" could only be answered by reading
 * a log file, which is how a dead watcher went unnoticed three times.
 */
function beat() {
    if (!key) return
    const file = path.join(HERE, `slack-watcher-${key}.json`)
    try {
        const temp = `${file}.${process.pid}.tmp`
        fs.writeFileSync(temp, JSON.stringify({ pid: process.pid, channel: key, at: Date.now() }))
        fs.renameSync(temp, file)
    } catch {
        // Never worth failing a poll over.
    }
}

let running = false
async function tick() {
    if (running) return
    running = true
    beat()
    try {
        if (sessionGone()) {
            console.error('[watch-mentions] the Slack server for this channel has stopped; exiting rather than becoming an orphan')
            process.exit(0)
        }
        await poll()
    } catch (err) { console.error(`[watch-mentions] ${err.message}`) }
    finally { running = false }
}

setInterval(tick, 2000)
tick()
