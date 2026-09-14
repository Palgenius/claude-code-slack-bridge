# Claude Code ⇄ Slack

[![tests](https://github.com/Palgenius/claude-code-slack-bridge/actions/workflows/test.yml/badge.svg)](https://github.com/Palgenius/claude-code-slack-bridge/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-green.svg)](package.json)

Talk to Claude Code from a Slack channel, and watch it work while it answers.

An MCP server that runs a Slack app in Socket Mode — no tunnel, no public IP,
nothing leaves your machine except what you send to Slack.

## What it looks like in Slack

You `@mention` the bot in a channel. Your message gets 👀 the moment Claude
picks it up, and ✅ when it finishes — so a question that was never seen is
obvious without reading anything.

```
Ali        10:14
           @claude why is the login page redirecting to itself?
           👀

claude  ᴀᴘᴘ 10:14
           ⏳ Working…  ·  1m 12s  ·  14 tools  ·  7.8k tokens
           why is the login page redirecting to itself?

           …3 earlier
           Bash  Run the full test suite
           Read  auth.ts
           Edit  routes.ts
              └ 2 replies
```

The card is **one message that rewrites itself** — the clock ticks, tool calls
scroll past. When the turn ends it becomes a summary of what changed:

```
claude  ᴀᴘᴘ 10:16
           ✅ Done  ·  2m 40s  ·  23 tools  ·  31k tokens
           why is the login page redirecting to itself?

           touched  auth.ts  routes.ts
              └ 2 replies
```

Claude's actual answer arrives **in the thread**, under your question:

```
              └ claude  ᴀᴘᴘ
                The guard tested `req.path`, which Express strips to the
                router-relative path, so its exemption never matched. Fixed in
                routes.ts — only new accounts had the flag, which is why only
                new users hit it.
```

A quick answer posts **no card at all**. The card appears once a turn calls a
tool or runs past ten seconds; below that the reply in the thread is the whole
record, and the channel stays quiet.

### The channel always says whether anyone is home

```
claude  ᴀᴘᴘ 10:02
           🟢 Claude is connected · my-project
           Listening here since 10:02 — @mention me and I'll pick it up.
```

And if the server is up but nothing is delivering messages to the session, it
says that instead — because "connected" would be a lie of omission:

```
claude  ᴀᴘᴘ 10:04
           🟡 Claude is connected but not listening · my-project
           Nothing is delivering messages to the session, so anything written
           here will wait unread. The session needs to start its mention watcher.
```

**That is the whole reason you never have to ask whether it is working.** The
one failure that looks like silence announces itself in the channel.

And if you @mention while it is in that state, you get an answer rather than
nothing:

```
              └ claude  ᴀᴘᴘ
                🟡 Got this, but nothing is delivering it to the session yet —
                so it is saved and unread rather than answered.
```

Worth knowing why this happens at all: **Claude Code does nothing at session
open.** It acts only when prompted, so the `CLAUDE.md` instruction that starts
the watcher runs on the session's first message rather than when the session
opens. Open a session, go straight to Slack, and nothing is listening yet.

Exactly one of these per channel, moved to the bottom whenever it changes — so
it is never buried under a day of conversation. When the session ends, the same
line becomes:

```
           ⚪ Claude is offline · my-project
           Was connected 10:02–18:30 (8h 28m). Nothing is listening in this
           channel right now.
```

Without it, a quiet channel and a dead one look identical.

### A checklist for longer jobs

`slack_progress` keeps a multi-step job to one self-rewriting message:

```
claude  ᴀᴘᴘ 11:31
           Deploy
           ✅ read the deployed file
           ✅ upload the release
           ⏳ run the deploy script      ← bold: the one running now
           ⏳ verify
```

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
- **Mentions sent while nothing was connected are recovered on the next start** —
  Socket Mode drops events for a disconnected app, so these used to be lost
  outright rather than merely late
- **The watcher is supervised** — if it crashes it is respawned, rather than
  taking inbound down for the rest of the session
- Servers exit with their session instead of orphaning and holding a socket
- Status lines left behind by a crash are corrected by any other live session

**Care with secrets** (streaming is off by default)
- `thinking` blocks have **no path** to the output
- Credentials are masked on the way out: `pass=`, Slack tokens, connection
  strings, bearer headers, private keys, long hex runs
- Tool detail, when enabled, uses only fields written to be read — never a
  command string, never file contents

---

## Creating the Slack app

Do this once per workspace. It takes about five minutes. Every step is in the
Slack app settings at <https://api.slack.com/apps>.

### 1. Create the app

**Create New App** → **From scratch** → give it a name (this is what people will
`@mention`, e.g. `claude`) → pick your workspace → **Create App**.

### 2. Turn on Socket Mode

Left sidebar → **Socket Mode** → toggle **Enable Socket Mode** on.

It asks for a token name — anything, e.g. `socket`. It then shows a token
starting with **`xapp-`**.

> **Copy it now.** This is your `SLACK_APP_TOKEN` and Slack will not show it
> again. If you lose it, generate a new one under **Basic Information →
> App-Level Tokens**.

### 3. Add the bot scopes

Left sidebar → **OAuth & Permissions** → scroll to **Scopes** → **Bot Token
Scopes** → **Add an OAuth Scope** for each:

**Required** — without these nothing works:

| Scope | Needed for |
| --- | --- |
| `chat:write` | Posting, editing and deleting the bot's own messages |
| `channels:history` | Reading messages in **public** channels |
| `groups:history` | Reading messages in **private** channels |

**Optional** — each one adds a feature, and skipping it costs only that
feature. Nothing breaks; the log says what was refused:

| Scope | Without it |
| --- | --- |
| `reactions:write` | No 👀 / ✅ marks on your message. Everything else works. |
| `im:history` | The bot cannot be used in a DM (see step 5) |
| `files:read` | Images and files people send cannot be downloaded |
| `files:write` | `send_slack_image` fails |
| `canvases:write` | `create_slack_canvas` fails |
| `pins:write` | Only needed if you set `SLACK_STATUS_PIN=1` |

**Add nothing else.** This token ends up in a config file on your machine, so
every extra scope is something it can do if it leaks. In particular you need no
**User Token Scopes** at all — everything runs on the bot token.

### 4. Subscribe to message events

Left sidebar → **Event Subscriptions** → toggle **Enable Events** on.

There is **no Request URL to fill in** — Socket Mode replaces it. Ignore that box.

Open **Subscribe to bot events** and add:

| Event | For |
| --- | --- |
| `message.channels` | Public channels |
| `message.groups` | Private channels |
| `message.im` | Direct messages |

Then **Save Changes** at the bottom of the page. It is easy to miss.

### 5. Let people DM the bot

Left sidebar → **App Home** → scroll to **Show Tabs** → turn the **Messages
Tab** on, and tick **"Allow users to send Slash commands and messages from the
messages tab."**

> Skip this and the DM box is **read-only** — you cannot even type to the bot.
> The scope and the event from the previous steps are not enough on their own,
> and nothing about the failure points at this setting.

Only needed for DMs. Channels work without it.

### 6. Install it

Left sidebar → **Install App** → **Install to Workspace** → **Allow**.

You now get a **Bot User OAuth Token** starting with **`xoxb-`**. This is your
`SLACK_BOT_TOKEN`.

> ⚠️ **Every time you change a scope after this, come back and click
> "Reinstall to Workspace"** (a yellow banner appears at the top). A new scope
> does nothing until you do. The usual symptom is a `403` with an HTML page
> where a file should be.

### 7. Invite the bot to your channel

In Slack itself, in the channel you want to use:

```
/invite @YourBotName
```

Without this the bot receives nothing from that channel, whatever scopes it has.

### 8. Get the channel ID

Right-click the channel in the sidebar → **View channel details** → scroll to
the bottom. The ID starts with **`C`**, e.g. `C01ABCDEFGH`. This is your
`SLACK_CHANNEL_ID`.

*(It is also the last part of the channel's URL in the browser version.)*

### You should now have three values

```
SLACK_APP_TOKEN   xapp-…   from step 2
SLACK_BOT_TOKEN   xoxb-…   from step 6
SLACK_CHANNEL_ID  C…       from step 8
```

The two tokens are **not** interchangeable. Swapping them gives
`not_allowed_token_type` on every send, which is a confusing error to debug.

---

## Quick start

**1. Create the Slack app** — the eight steps above.

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
                      │   supervise-watch.mjs → watch-mentions.mjs
                      │        (Monitor, persistent)
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
| `supervise-watch.mjs` | Keeps the watcher alive — what a session actually starts |

---

## Tests

```bash
npm test
```

281 tests over eight modules using the Node test runner through `tsx` — no test
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
