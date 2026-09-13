#!/usr/bin/env node
/**
 * Keep watch-mentions.mjs alive.
 *
 * The watcher is the only thing that carries a Slack message into a session.
 * When it dies, nothing announces it: the session sees silence, which looks
 * exactly like nobody having written. That happened five times on 13 Sept
 * alone -- twice mid-deploy, once with a question already waiting.
 *
 * Running the watcher directly under a Monitor does not survive this, because
 * the watcher exiting *is* the Monitor task ending. So the Monitor runs this
 * instead: a parent that never exits on a crash and respawns the child
 * underneath. Stdout is passed straight through, so a mention still arrives as
 * a Monitor event exactly as before.
 *
 * Usage -- identical to the watcher, every argument is forwarded:
 *
 *   node supervise-watch.mjs --config E:/yas_apps/2FA_app/.mcp.json
 *
 * The watcher's exit codes are a deliberate contract, and all three are
 * honoured rather than blanket-restarted:
 *
 *   2  bad usage or unreadable config. Restarting cannot fix it, and a hot
 *      loop on a typo'd path would bury the one message that explains it.
 *   0  the MCP server for this channel has stopped, and the watcher stood
 *      down on purpose. Respawning would leave an orphan polling Slack for a
 *      session that no longer exists.
 *   *  a crash. This is the case worth surviving.
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WATCHER = path.join(HERE, 'watch-mentions.mjs')
const ARGS = process.argv.slice(2)

// Backoff between attempts. Starts quick, because most crashes are transient
// and a Slack message may already be waiting; grows so a real outage does not
// become a notification flood, since a Monitor producing too many events is
// stopped automatically -- which would defeat the whole point of this file.
const DELAYS_MS = [2000, 5000, 15000, 30000, 60000]

// A child that survives this long is considered to have started properly, and
// resets the backoff. Below it, the failure is at startup rather than in the
// poll loop.
const HEALTHY_MS = 60000

// Give up after this many consecutive failures to even start. Something is
// wrong that restarting will not fix -- a moved file, a revoked token -- and
// saying so once is more use than trying forever in silence.
const MAX_QUICK_FAILURES = 10

// After this many restarts in a row, stop announcing each one on stdout and
// report to stderr instead (captured in the task output file, but not a
// notification). The first few are worth interrupting for; the eightieth is
// noise, and noise is what gets a Monitor killed.
const QUIET_AFTER = 3

let attempt = 0
let quickFailures = 0
let announced = 0

const out = (line) => console.log(`[supervise] ${line}`)
const log = (line) => console.error(`[supervise] ${line}`)

function start() {
  const startedAt = Date.now()

  // stdio inherited: the child writes to our stdout directly, so a mention
  // reaches the Monitor unchanged and un-buffered. Nothing is re-encoded here,
  // which also means nothing here can corrupt a message.
  const child = spawn(process.execPath, [WATCHER, ...ARGS], {
    stdio: ['ignore', 'inherit', 'inherit'],
  })

  child.on('error', (err) => {
    log(`could not start the watcher: ${err.message}`)
    schedule(Date.now() - startedAt);
  })

  child.on('exit', (code, signal) => {
    const lived = Date.now() - startedAt

    if (code === 2) {
      out('the watcher refused its arguments (exit 2) — not restarting, '
        + 'since a bad config cannot fix itself. Slack is now DEAF.')
      process.exit(2)
    }

    if (code === 0) {
      out('the Slack server for this channel has stopped, so the watcher stood '
        + 'down. Not restarting — it would be an orphan.')
      process.exit(0)
    }

    const how = signal ? `signal ${signal}` : `exit ${code}`
    schedule(lived, how)
  })

  // Pass a stop straight down, so Ctrl-C or TaskStop does not leave the child
  // behind polling Slack forever.
  const relay = (sig) => () => {
    try { child.kill(sig) } catch { /* already gone */ }
    process.exit(0)
  }
  process.once('SIGINT', relay('SIGINT'))
  process.once('SIGTERM', relay('SIGTERM'))
}

function schedule(lived, how = 'startup failure') {
  if (lived >= HEALTHY_MS) {
    // It ran properly and then fell over. Treat this as the first failure
    // again -- otherwise one bad week slowly pushes a healthy watcher onto a
    // sixty-second delay it never earns its way back from.
    if (announced > QUIET_AFTER) out(`watcher recovered earlier, then stopped (${how})`)
    attempt = 0
    quickFailures = 0
    announced = 0
  } else {
    quickFailures += 1
  }

  if (quickFailures >= MAX_QUICK_FAILURES) {
    out(`the watcher has failed ${quickFailures} times without staying up. `
      + 'Giving up rather than looping in silence — Slack is now DEAF for this '
      + 'session, and something needs looking at.')
    process.exit(1)
  }

  const wait = DELAYS_MS[Math.min(attempt, DELAYS_MS.length - 1)]
  attempt += 1
  announced += 1

  const note = `watcher stopped (${how}) after ${Math.round(lived / 1000)}s — `
    + `restarting in ${wait / 1000}s`

  // The first few restarts are worth a notification; after that it is a known
  // ongoing outage and repeating it only risks the Monitor being throttled.
  if (announced <= QUIET_AFTER) out(note)
  else log(`${note} (quiet: ${announced} in a row)`)

  setTimeout(start, wait)
}

out(`supervising ${path.basename(WATCHER)} — a crash will be restarted, `
  + 'a deliberate stop will not')
start()
