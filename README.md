# Claude Code ⇄ Slack

[![tests](https://github.com/Palgenius/claude-code-slack-bridge/actions/workflows/test.yml/badge.svg)](https://github.com/Palgenius/claude-code-slack-bridge/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-green.svg)](package.json)

Talk to Claude Code from a Slack channel, and watch it work while it answers.

An MCP server that runs a Slack app in Socket Mode — no tunnel, no public IP,
nothing leaves your machine except what you send to Slack.

```
You  @claude deploy the staging branch and tell me if the tests pass

     ⏳ Working…  ·  1m 12s  ·  14 tools  ·  7.8k tokens
     Bash  Run the full test suite
     Edit  deploy.ts
     Read  config.yml
```

…and that same message rewrites itself when the turn ends:

```
     ✅ Done  ·  2m 40s  ·  23 tools  ·  31k tokens
     touched  deploy.ts  config.yml
```

Your message gets 👀 the moment Claude picks it up and ✅ when it finishes, so a
question that was never seen is obvious without reading anything.

---

## Why this exists

Claude Code delivers `notifications/claude/channel` **only** when the session was
started with `--channels`, a research-preview flag the desktop app does not pass.
The notification is accepted and then dropped by a capability gate — silently,
with no error in any log, in Slack, or on screen.

So the obvious design (MCP server pushes the message at Claude) cannot work on
most machines. This project works around it: mentions are written to a
per-channel inbox on disk, and a small watcher turns each new one into an event
in the session. Outbound has no counterpart API at all, so the live view is built
by tailing the session transcript Claude Code already writes.

Everything here was verified against a live workspace. Where something is a
recommendation rather than a fact about the code, the docs say so.

---

## Features

**Conversation**
- Replies land **in the thread** you asked in, not at the top of the channel
- **Markdown is converted** to Slack's dialect — `**bold**`, headings, links and
  fenced code render properly instead of showing their syntax
- Long messages are **split on line boundaries**, never truncated and never cut
  inside a code fence
- **Direct messages** work without an `@mention`
- Images and files you send are downloaded so Claude can actually look at them

**Seeing what's happening**
- A **live turn card** that ticks with elapsed time, tool count and tokens, then
  collapses to the list of files the turn changed
- **`slack_progress`** — a checklist kept to one self-rewriting message
- A **presence line** per channel: 🟢 connected / ⚪ offline — exactly one message,
  moved to the bottom of the channel when it changes so it is never buried
- **`slack_status`** — one call answers "is this actually working?"

**Not losing things**
- Per-channel inbox and read cursor, so several projects don't read each other's
  messages
- A message Slack delivers to the wrong project's server is **routed to the right
  inbox** rather than silently dropped
- Servers exit with their session instead of orphaning and holding a socket
- Status lines left behind by a crash are corrected by any other live session

**Care with secrets** (streaming is off by default)
- `thinking` blocks have **no path** to the output
- Credentials are masked on the way out: `pass=`, Slack tokens, connection
  strings, bearer headers, private keys, long hex runs
- Tool detail, when enabled, uses only fields written to be read — never a
  command string, never file contents

---

## Quick start

**1. Create a Slack app** ([full steps](SETUP-NEW-PROJECT.md)) — Socket Mode on,
an app token (`xapp-`), a bot token (`xoxb-`), the scopes listed in the setup
guide, and `/invite @YourBot` to the channel.

**2. Install:**

```bash
git clone https://github.com/Palgenius/claude-code-slack-bridge.git
cd claude-code-slack-bridge && npm install
```

**3. Add `.mcp.json` to your project:**

```json
{
  "mcpServers": {
    "slack-channel": {
      "type": "stdio",
      "command": "npx",
      "args": ["tsx", "/path/to/claude-code-slack-bridge/webhook.ts"],
      "env": {
        "SLACK_APP_TOKEN": "xapp-...",
        "SLACK_BOT_TOKEN": "xoxb-...",
        "SLACK_CHANNEL_ID": "C0..."
      }
    }
  }
}
```

**4. Add the watcher section to your project's `CLAUDE.md`** — copy it from
[SETUP-NEW-PROJECT.md](SETUP-NEW-PROJECT.md).

**5. Restart Claude Code**, then ask it: *"is slack connected?"*

---

## ⚠️ The one thing to know

There are **two** processes and only one starts by itself.

| | Starts automatically? | Without it |
| --- | --- | --- |
| **MCP server** | ✅ with the session | Nothing works |
| **Mention watcher** | ❌ **no** | Messages arrive, are stored correctly, and **nothing ever surfaces them** |

That second failure is the one that will cost you an evening: outbound keeps
working, the channel looks alive, and the silence is indistinguishable from
nobody having written to you.

**So `slack_status` is the first thing to run whenever Slack seems quiet.** The
`Watcher:` line is the answer most of the time.

---

## Documentation

| | |
| --- | --- |
| **[QUICK-REFERENCE.md](QUICK-REFERENCE.md)** | One page — the session ritual, symptom→cause table, every tool and command. **Start here.** |
| **[SETUP-NEW-PROJECT.md](SETUP-NEW-PROJECT.md)** | Full procedure for wiring a project, and troubleshooting in the order that finds the problem fastest |
| [SLACK_MCP_INTEGRATION.md](SLACK_MCP_INTEGRATION.md) | Why the design is what it is — the capability gate, Socket Mode load-balancing, the transcript format |
| [CHANGES.md](CHANGES.md) | Every change and the reasoning behind it, including the failures |

---

## Tools Claude gets

| Tool | For |
| --- | --- |
| `slack_status` | Is the bridge actually working, end to end |
| `send_slack_message` | Replying. Pass `thread_ts` back. |
| `update_slack_message` | Rewriting a message in place |
| `slack_progress` | A checklist for a multi-step job, kept to one message |
| `send_slack_image` | A screenshot or chart, inline |
| `create_slack_canvas` | Reference material that shouldn't scroll away |
| `check_slack_inbox` | Reading unread mentions manually |

---

## Architecture

```
Slack ──socket──► webhook.ts ──► slack-inbox-<channel>.jsonl
                      │                      │
                      │                      ▼
                      │        watch-mentions.mjs  (Monitor, persistent)
                      │                      │
                      │                      ▼
                      │              Claude Code session
                      │                      │
                      └────◄── tools ◄───────┘

            ~/.claude/projects/…/<session>.jsonl
                        │
                        ▼   tailed, when SLACK_STREAM=1
                  the live turn card
```

| Module | |
| --- | --- |
| `webhook.ts` | MCP server: tools, Slack listener, the live view |
| `inbox.ts` | Per-channel mention inbox, mention matching, subtype rules |
| `slackRich.ts` | Post, edit, upload, canvas, react — `fetch` injected so it is testable |
| `mrkdwn.ts` | Markdown → Slack mrkdwn, and splitting an over-long message |
| `turn.ts` | Reading turns out of the transcript, and rendering the live card |
| `progress.ts` | The `slack_progress` checklist |
| `presence.ts` | The 🟢/⚪ status line and the heartbeat files |
| `transcript.ts` | Finding and tailing the session transcript, and redaction |
| `watch-mentions.mjs` | Turns a stored mention into an event in the session |

---

## Tests

```bash
npm test
```

236 tests over eight modules using the Node test runner through `tsx` — no test
dependencies. `slackRich.ts` takes `fetch` and `fs` as injected dependencies, so
the Slack call sequences are checked without a workspace.

The turn tracker is also replayed against a real session transcript, not only
fixtures. That is how the bug where one finished turn swallowed every later one
was found: every fixture happened to begin with a user prompt, so the case that
breaks it could not appear in one.

---

## Known limits

- **The watcher does not start itself.** The `CLAUDE.md` section makes Claude
  start it; that is advice to a model, not a hook. Verify with `slack_status`.
- **Two projects on one Slack app share delivery at random.** Socket Mode
  load-balances across every connection. Strays are recovered through the
  per-channel inbox, so they are late rather than lost — but prefer one Slack app
  per project.
- **No way to interrupt Claude from Slack.** Nothing in the protocol carries it.
- **The live view is a second or two behind** and cannot show a partial sentence.
- **`send_slack_image` will upload any path it is given**, with no allowlist.
- **Markdown tables become monospaced blocks.** Slack has no table syntax, so
  the columns are padded to line up rather than arriving as stray pipes.

---

## Credits

Built on [AppGambitStudio/Claude-Code-Slack-Channel](https://github.com/AppGambitStudio/Claude-Code-Slack-Channel)
by [Dhaval Nagar](https://github.com/AppGambitStudio) — the original Socket Mode
MCP server and the `send_slack_message` tool. This project extends it with the
inbox, threading, markdown conversion, the live view, progress boards, presence
and status tooling.

MIT, with the original copyright retained. See [LICENSE](LICENSE).
