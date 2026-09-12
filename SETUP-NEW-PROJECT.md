# Wiring a new project to Slack

Everything you need to put a Claude Code project on a Slack channel: the
one-time workspace setup, the per-project setup, what to do at the start of
each session, and how to tell whether it is actually working.

Written from a machine that runs two projects against one Slack app. Every
claim here was checked against a live system, not inferred from the code.

> For the *why* behind the design — the capability gate, the Socket Mode
> load-balancing, the transcript format — see `SLACK_MCP_INTEGRATION.md`. This
> file is the procedure.

---

## The one thing to know before anything else

There are **two** processes, and only one starts by itself.

| | Starts automatically? | Without it |
| --- | --- | --- |
| **MCP server** (`webhook.ts`) | ✅ yes, when the session opens | Nothing works at all |
| **Mention watcher** (`watch-mentions.mjs`) | ❌ **no** | Messages arrive and are written to the inbox correctly — and **nothing ever surfaces them** |

The second failure is the one that will waste your evening, because it looks
exactly like nobody having written to you. Outbound keeps working, so the
channel looks alive. It caused three separate debugging sessions before the
cause was found.

**So: `slack_status` is the first thing to run when Slack seems quiet.**

---

## 1. One-time: the Slack app

Do this once per workspace, not per project.

1. **Create an app** at <https://api.slack.com/apps> → *From scratch*.
2. **Socket Mode** → on. Generate an **App-Level Token** with
   `connections:write`. Starts `xapp-` → this is `SLACK_APP_TOKEN`.
3. **OAuth & Permissions → Bot Token Scopes**:

   | Scope | For |
   | --- | --- |
   | `chat:write` | posting and editing — **required** |
   | `channels:history` | reading public channels |
   | `groups:history` | reading **private** channels |
   | `im:history` | direct messages to the bot |
   | `files:read` | downloading images people send |
   | `files:write` | uploading images and files |
   | `canvases:write` | creating canvases |
   | `reactions:write` | the 👀 / ✅ lifecycle on the asker's message |

4. **Event Subscriptions** → on → subscribe to bot events `message.channels`,
   `message.groups`, `message.im`. **Save Changes.**
5. **Install App** → the Bot User OAuth Token starts `xoxb-` → this is
   `SLACK_BOT_TOKEN`.
6. **Invite the bot** to the channel: `/invite @YourBotName`.

> A new scope does nothing until you click **Reinstall to Workspace**. This is
> the step people miss; the symptom is a `403` with an HTML body where a file
> should be.

### Should a new project get its own Slack app?

**Yes, if you can.** Slack hands each incoming message to **one randomly chosen**
connection, and every project runs its own server on the same app token. Two
projects on one app means roughly half of each one's messages arrive at the
other's server.

That is now recovered rather than lost — the wrong server writes the message to
the right channel's inbox — but it arrives when the other session next reads,
not instantly. A second Slack app removes the problem entirely.

---

## 2. Per-project: two files

### 2.1 `.mcp.json` in the project root

```json
{
  "mcpServers": {
    "slack-channel": {
      "type": "stdio",
      "command": "npx",
      "args": ["tsx", "D:\\MCP-tools\\Claude-Code-Slack-Channel\\webhook.ts"],
      "env": {
        "SLACK_APP_TOKEN": "xapp-...",
        "SLACK_BOT_TOKEN": "xoxb-...",
        "SLACK_CHANNEL_ID": "C0..."
      }
    }
  }
}
```

`SLACK_CHANNEL_ID` is **not optional** when more than one project is wired up.
It is what gives this project its own inbox, its own read cursor and its own
status line. Without it the project shares one inbox with every other, and
whichever session reads first marks the others' messages read.

Optional extras:

| Variable | Effect |
| --- | --- |
| `SLACK_STREAM=1` | Mirror Claude's side of the session into the channel — see §5 |
| `SLACK_STREAM_TOOLS` | `0` nothing, `1` tool names, `detail` name + a safe target |
| `SLACK_ANNOUNCE=0` | Do not post the 🟢/⚪ status line |
| `SLACK_PROJECT_NAME` | Name shown on the status line (default: the folder name) |

### 2.2 A section in the project's `CLAUDE.md`

This is what makes the watcher start without you asking. Append:

````markdown
## Slack bridge — start the watcher at session start

This project is wired to Slack through the MCP server at
`D:\MCP-tools\Claude-Code-Slack-Channel` (channel `C0...`).

**At the start of every session, before anything else, start the mention
watcher.** Without it, Slack messages are written to the inbox correctly and
nothing ever surfaces them. The MCP server starts on its own; the watcher does
not.

Run the `slack-watch` skill, or start it directly:

```
Monitor({
  command: 'node "D:/MCP-tools/Claude-Code-Slack-Channel/watch-mentions.mjs" --config "<project path>/.mcp.json"',
  description: 'Slack @mentions for <project>',
  persistent: true,
  timeout_ms: 3600000,
})
```

**Never start it with Bash `run_in_background` (10 min cap) or a Monitor
without `persistent: true` (5 min cap).** The watcher polls forever, so either
one kills it part-way through the session and inbound goes silently dead.

Then confirm with the `slack_status` tool — the `Watcher:` line must read
`RUNNING`.
````

Restart Claude Code after adding `.mcp.json`; the server is spawned at session
start.

---

## 3. Every session

1. **Open the project.** The MCP server connects on its own and a green line
   appears in the channel:

   ```
   🟢 Claude is connected · my_project
   Listening here since 09:14 — @mention me and I'll pick it up.
   ```

2. **The watcher should start on its own** because of the `CLAUDE.md` section.
   It is not guaranteed — that text is advice to the model, not a hook.

3. **Verify. Do not assume.** Ask:

   > is slack connected?

   or run `/slack-watch`, which starts it and checks in one step.

   The `Watcher:` line is the one that matters:

   ```
   Server:  connected to Slack, pid 41580, up 59s
   Channel: C0C17J47NLW   Project: 2FA_app
   Bot:     U0C17G82RHR
   Watcher: RUNNING, pid 34632          ← this line
   Unread in this channel: 0
   Streaming: on (tool detail: none)
   ```

   If it says `NOT RUNNING`, run `/slack-watch`.

---

## 4. Commands and tools

### Slash command

| | |
| --- | --- |
| `/slack-watch` | Start the watcher for this project, correctly, and report what was waiting. Safe to run twice — it checks for an existing one first. |

### Tools Claude gets

| Tool | Arguments | Notes |
| --- | --- | --- |
| `slack_status` | — | **Run this first when anything looks wrong.** |
| `send_slack_message` | `channel`, `text`, `thread_ts?` | Returns `ts`. Markdown is converted; long messages are split, not truncated. |
| `update_slack_message` | `channel`, `ts`, `text` | Rewrites a message in place. |
| `slack_progress` | `channel`, `steps?`, `ts?`, `update?`, `advance?` | A checklist kept to one self-rewriting message. |
| `send_slack_image` | `channel`, `file_path`, `title?`, `comment?`, `thread_ts?` | Uploads a local file inline. |
| `create_slack_canvas` | `channel`, `title`, `markdown` | For reference material rather than a message that scrolls away. |
| `check_slack_inbox` | `peek?` | Mentions not yet read. The manual fallback when no watcher is running. |

Always pass `thread_ts` back from an incoming message so the answer sits under
the question.

### The watcher, from a terminal

```bash
node "D:/MCP-tools/Claude-Code-Slack-Channel/watch-mentions.mjs" --config "<project>/.mcp.json"
```

The bot id and channel are read out of that config. Overrides:
`--channel C0…`, a bot id as the first positional argument, extra log paths at
the end.

First line should read `watching for @U… in C…`. A `WARNING: started without
--channel` block means the config was not read and it is watching the wrong
inbox.

### Housekeeping

```bash
cd D:/MCP-tools/Claude-Code-Slack-Channel && npm test      # 234 tests
```

---

## 5. Streaming (optional, off by default)

`SLACK_STREAM=1` mirrors Claude's side of the session into the channel as one
card per turn that rewrites itself:

```
⏳ Working…  ·  1m 12s  ·  14 tools  ·  7.8k tokens
Bash  Run the full test suite
Edit  turn.ts
```

then, when the turn ends:

```
✅ Done  ·  2m 40s  ·  23 tools  ·  31k tokens
touched  webhook.ts  turn.ts
```

**Read this before enabling it.** It forwards Claude's side of the session to
an external service. `thinking` blocks have no path to the output at all, and
credentials are masked on the way out — `pass=`, Slack tokens, connection
strings, bearer headers, private keys, long hex runs. But masking is
pattern-matching, not a guarantee, and Claude's prose quotes files and command
output. While this tool was being built it printed a database password read
from an Apache config.

Turn it on for a channel you would be comfortable pasting your terminal into.
`SLACK_STREAM_TOOLS=detail` additionally shows a short target per tool call,
using only fields written to be read (Bash's `description`, a file's basename,
a search pattern) — never a command string or file contents.

---

## 6. Troubleshooting, in the order that finds it fastest

**1. Run `slack_status`.** It answers in one call what otherwise takes a log
file and a process list. `Watcher: NOT RUNNING` is the answer most of the time.

**2. Watcher running but nothing arrives?** Check its first line. A
`WARNING: started without --channel` block means it is polling the old shared
`slack-inbox.jsonl` instead of this channel's file.

**3. Messages appearing in the wrong session?** Two projects on one Slack app.
`slack_status` lists the other channels. They are recovered, not lost, but
arrive late — see §1.

**4. Count the servers.** Every line in `slack-debug.log` is tagged
`[pid channel]`. A pid still writing whose session is gone is an orphan holding
a socket:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'preflight' } |
  ForEach-Object { "{0} parent-alive={1}" -f $_.ProcessId,
    ((Get-CimInstance Win32_Process -Filter "ProcessId=$($_.ParentProcessId)") -ne $null) }
```

A run of `EPIPE: broken pipe` in the log is the same thing from the other side.

**5. Nothing at all, ever?** The bot is not in the channel (`/invite`), a scope
was added without **Reinstall to Workspace**, or the two tokens are swapped —
`xapp-` is `SLACK_APP_TOKEN`, `xoxb-` is `SLACK_BOT_TOKEN`. Swapping them gives
`not_allowed_token_type` on every send.

---

## 7. Files this creates, next to the server

All gitignored. All local to the machine.

| File | |
| --- | --- |
| `slack-inbox-<channel>.jsonl` | Mentions for one channel, append-only, rotates at 4MB |
| `slack-inbox-<channel>.cursor` | How far `check_slack_inbox` has read |
| `slack-alive-<channel>.json` | Server heartbeat — "is anything connected" |
| `slack-watcher-<channel>.json` | Watcher heartbeat — "is anything listening" |
| `slack-status-<channel>.json` | Which message is the channel's 🟢/⚪ status line |
| `slack-debug.log` | Everything every server did, tagged `[pid channel]` |
| `attachments/` | Images downloaded from Slack |

---

## 8. Known limits

- **The watcher does not start itself.** The `CLAUDE.md` section makes Claude
  start it; that is advice, not a guarantee. Verify with `slack_status`.
- **Two projects on one Slack app share delivery at random.** Recovered through
  the per-channel inbox, so late rather than lost. A second app fixes it; a
  broker process owning the single socket is the real fix.
- **A crash with nothing else running leaves a stale green status line.** Any
  live server sweeps abandoned lines, but if everything is closed there is
  nobody to sweep. The next session to start corrects it.
- **No way to interrupt Claude from Slack.** Nothing in the protocol carries it.
- **The live view is a second or two behind** and cannot show a partial
  sentence; it updates when a block is complete.
- **`send_slack_image` will upload any path it is given.** Nothing restricts it
  to a project directory.
- **Markdown tables are left as pipes.** Slack has no table syntax.
