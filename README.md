# Claude Code Slack Channel

Connect Claude Code to your Slack workspace using the Model Context Protocol (MCP). This server runs a Slack App in Socket Mode that routes incoming messages from Slack directly into your local Claude Code session, and gives Claude the ability to securely reply back!

## Features

- **Two-Way Communication**: Send messages from Slack to Claude Code, and allow Claude Code to natively reply using an MCP tool (`send_slack_message`).
- **Zero Configuration Tunnels**: Uses Slack Socket Mode, meaning no `ngrok` or public IP addresses are required. Runs completely locally!
- **Private Channel Support**: Fully supports routing messages from private Slack channels.

## Setup Instructions

### 1. Create a Slack App
1. Go to [Slack API Apps](https://api.slack.com/apps) and click **Create New App** > **From scratch**.
2. Go to **Socket Mode** (left sidebar) and toggle it **On**.
3. Generate an **App-Level Token** with the `connections:write` scope. *(Starts with `xapp-`)*.
4. Go to **OAuth & Permissions** (left sidebar), scroll to **Scopes > Bot Token Scopes**, and add the `channels:history`, `chat:write`, and `groups:history` scopes. Add `im:history` too if you want to talk to the bot in a direct message.
5. Go to **Event Subscriptions** (left sidebar), toggle **Enable Events** to **On**, and subscribe to `message.channels` and `message.groups` under "Subscribe to bot events" — plus `message.im` for direct messages.
6. **Important**: Scroll to the bottom and click **Save Changes**.
7. Go to **Install App** and install it into your workspace to get your **Bot User OAuth Token** *(Starts with `xoxb-`)*.

### 2. Configure Claude Code
You can add this MCP server to your global Claude Code configuration (`~/.claude.json`) or to a project-specific `.claude.json` configuration. 

Run `npm install` in this directory to install the `@slack/bolt` and `tsx` dependencies. Then, add the following to your `mcpServers` block, replacing the path and tokens with your actual values:

```json
{
  "mcpServers": {
    "slack-channel": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "tsx",
        "/path/to/this/repository/webhook.ts"
      ],
      "env": {
        "SLACK_APP_TOKEN": "xapp-...",
        "SLACK_BOT_TOKEN": "xoxb-...",
        "SLACK_CHANNEL_ID": "C0..." // Optional: add a channel ID here so it only listens to one specific channel!
      }
    }
  }
}
```

### 3. Usage
- Simply restart Claude Code. The server will initialize in the background and connect to Slack.
- Invite your bot to any channel in Slack using `/invite @YourBotName`.
- Send a message in that channel, and it will seamlessly appear in Claude Code as context!
- You can ask Claude Code directly to "Reply to that Slack message" and it will autonomously use the `send_slack_message` tool to post back.

## ⚠️ Architecture Caveat: Global vs. Local Configuration
Slack's Socket Mode allows multiple WebSocket connections using the identical App Token, and **load-balances (randomizes)** incoming messages across all connected clients. 

Because of this:
- **Global Configuration (`~/.claude.json`)**: If you have multiple Terminal windows open running Claude Code simultaneously, each window spawns its own MCP server. When you send a Slack message, Slack will randomly route it to only *one* of your active terminals.
- **Local Configuration (`./.claude.json`)**: If you only want Slack messages to route uniquely to a specific project workspace, do not configure this server globally. Instead, configure the `mcpServers` block in a local `.claude.json` file inside that specific project folder so the webhook server is only spawned when you are actively working in that directory.

## Troubleshooting
If messages aren't arriving:
- Ensure you have invited the bot to the channel.
- Ensure you clicked the yellow "Reinstall to Workspace" banner in Slack after changing event scopes.
- Check the `slack-debug.log` file generated in the root of this repository.

---

# Local modifications (12 September 2026)

This copy has been changed. `webhook.ts.bak-20260912-183246` is the original.

## The problem these solve

Incoming messages never reached Claude. The cause was not in this server: it
forwarded every message correctly. Claude Code only delivers
`notifications/claude/channel` when its session was started with `--channels`,
and **the Claude desktop app does not pass that flag** — the notification is
accepted and then dropped by a capability gate, silently, with no error in
this log, in Slack, or on screen.

`--channels` is a research preview and only reachable from the terminal CLI,
so on a machine where the desktop app is the only option the native path
cannot be used at all.

## What was added

**A mention inbox.** Messages that `@mention` the bot are appended to
`slack-inbox.jsonl` as well as being pushed at the gate. Append-only, because
Slack load-balances Socket Mode across every connected client and several
instances may be writing at once.

**`watch-mentions.mjs`** turns each new mention into a line on stdout. Run it
under a Claude Code Monitor and every line becomes an event in the session —
which is how a Slack message reaches Claude without the flag:

```
node watch-mentions.mjs <botUserId> --config <path to .mcp.json> [extraLogPath ...]
```

`--config` is only used to read the bot token for downloading attachments; it
is read from the file so the token never appears in a command line. It also
parses an older instance's `slack-debug.log`, so it works while a session
started before these changes is still running.

**Five new tools:** `check_slack_inbox` (mentions not yet read),
`send_slack_image` (upload a local file inline — `files.upload` is deprecated,
so this is the three-step `getUploadURLExternal` → PUT → `completeUploadExternal`
replacement), `create_slack_canvas` (markdown canvas, falling back to a
standalone canvas shared into the channel, since a channel holds only one),
`update_slack_message` (rewrite a message already posted), and `slack_progress`
(below).

`send_slack_message` returns the message timestamp, and `update_slack_message`
takes it. That pair is what a live "working on it" marker needs: post once,
rewrite the same message as the job moves, rewrite it a last time when it is
done — one changing line instead of a scroll of progress reports.

**A live progress checklist — `slack_progress`.** One message in the channel
that rewrites itself as the work moves:

```
Deploy
✅ reading the deployed file
✅ uploading the release
⏳ running the deploy script     ← bold, because it is the one running
⏳ verify
```

Call it once with `steps` to post the board and get back a `ts`; call it again
with that `ts` and either `update: [{step, status}]` or `advance: true` to move
it on. `step` is an index or any substring of the step's text, so a caller does
not have to track positions. The board is remembered in memory by `ts`, which
is what lets a single step move without resending the list — and if the server
has restarted since, it says so rather than rewriting the message with a board
that has silently lost its history.

`advance` is the call to reach for between stages: it finishes whatever is
active and starts the next pending step, which removes the commonest way to get
a board wrong — marking a step done, forgetting to start the next one, and
leaving the checklist looking stalled.

**Markdown is converted.** Claude writes GitHub-flavoured markdown; Slack
speaks a different dialect and renders the difference literally, so `**bold**`
arrived wearing its asterisks and `[text](url)` as the whole bracket-paren
construction. `mrkdwn.ts` converts on the way out. Code is parked before any
rule runs and restored at the end, so a regex meant for prose can never rewrite
something inside a code sample — which is what makes a careless converter worse
than none.

**Replies go into threads.** Incoming messages carry their `thread_ts` through
the inbox and the watcher, and every sending tool takes one. An answer sits
under the question instead of at the top of the channel.

**Long messages are split, not truncated.** Slack rejects anything over 4000
characters outright. This used to cut at 3900, which kept the message and lost
the conclusion. Now it splits on line boundaries — never inside a fenced code
block, since an unclosed fence renders the rest of the channel as code — and
hangs the continuation in a thread off the first part, so a long answer is
still one item in the channel.

**Direct messages work.** A DM is addressed to the bot by definition, so no
`@mention` is needed in one. Needs the `im:history` scope and the `message.im`
event.

## What was fixed

- **Only `@mention`s are collected.** The channel stays usable for ordinary
  conversation without waking Claude.
- **Subtype filtering.** The original skipped only `bot_message`, so
  huddle-started and message-edited events were forwarded with empty text.
  `file_share` and `thread_broadcast` are kept — a message with an image
  attached is still a person typing.
- **Absolute paths.** `slack-debug.log` was written to a bare relative path,
  so it landed in whatever directory the session started in rather than here.

- **Line breaks survive.** Stripping the `@mention` ran `\s+` over the whole
  message, so a pasted stack trace, numbered list or code block reached Claude
  as one run-on line. Only the space around the removed token is collapsed now.

- **A repeated message is read once.** Socket Mode redelivers on reconnect and
  several instances append to the inbox at the same time, so the same message
  genuinely lands in the file twice — and `check_slack_inbox` was handing
  Claude the same instruction twice in a row. Deduplicated by `ts`.

- **The server exits when its session does.** An orphan kept its Slack socket,
  so Slack load-balanced messages onto a dead pipe and they vanished with no
  error anywhere; the fix used to be hunting the process down by hand. It now
  shuts down when stdin closes, which is what the parent exiting looks like
  over stdio.

- **Missing tokens are named at startup.** The first symptom used to be either
  `invalid_auth` on a tool call or a socket that never connected, neither of
  which says which variable was left out of the config.

- **The log and the inbox rotate** at 4MB, keeping one generation. Both were
  append-only with no bound. `all()` reads the rotated generation too, so
  rotating cannot drop a mention nobody had read yet.

## The live view — watching Claude work (opt-in)

Claude Code has no outbound channel, but it writes the session to
`~/.claude/projects/<project>/<session-id>.jsonl` as it goes. The transcript
carries the whole shape of a turn, and it was not being read:

- a `user` entry whose content is a plain string is somebody asking
- `assistant` entries with `stop_reason: "tool_use"` are work continuing
- `stop_reason: "end_turn"` is the answer being finished
- `user` entries holding `tool_result` are the work coming back

`turn.ts` reads that and the channel renders it the way the terminal does — one
card per turn that rewrites itself while the work runs:

```
⏳ Working…  ·  1m 12s  ·  14 tools  ·  7.8k tokens

…3 earlier
Bash  Run the full test suite
Edit  turn.ts
Read  transcript.ts
```

and when the turn finishes, the activity gives way to what it changed:

```
✅ Done  ·  2m 40s  ·  23 tools  ·  31k tokens

touched  webhook.ts  turn.ts  README.md
```

Claude's prose arrives underneath as separate messages, in the same thread.

**Everything for a turn goes in one thread.** If a Slack mention started the
work it is the asker's own thread, and **their message gets 👀 while it runs and
✅ when it is finished** — so a question that was never picked up is obvious
without reading a word. A turn nobody asked for starts its own thread off the
card, so a long session stays one item in the channel.

**Off unless you turn it on.** Add to the server's `env` block:

```json
"SLACK_STREAM": "1",
"SLACK_STREAM_TOOLS": "0"
```

`SLACK_STREAM_TOOLS` controls how much of a tool call is shown:

| Value | Shows |
| --- | --- |
| `0` (default) | nothing about tools |
| `1` | the tool's name — `Bash`, `Edit` |
| `detail` | the name and a short target — `Bash  Run the full test suite` |

`detail` never includes a command string, a file's contents, or the code around
a match. It uses only fields written to be read: the one-line `description`
Bash and the agent tools carry, the **basename** of a file path, a search
pattern. All of it goes through the same redaction as the prose.

**Read this before enabling any of it.** This forwards Claude's side of the
session to an external service. `transcript.ts` drops `thinking` blocks
outright — private reasoning has no path to the output — and masks credentials
on the way out: `pass=`, `xox?-` tokens, connection strings, bearer headers,
private keys, long hex runs. That matters, because Claude's prose quotes files
and command output; while this was being built, it printed a database password
read from an Apache config, and an unredacted streamer would have posted it to
the channel.

Masking is pattern-matching, not a guarantee. A secret in an unusual shape will
go through. Enable it for a channel you would be comfortable pasting your
terminal into.

Messages are queued and drained at about one per second, which is
`chat.postMessage`'s per-channel rate limit. The card is rewritten every four
seconds while a turn runs, which is well inside `chat.update`'s allowance.

## Extra Slack scopes

`files:read` to download attachments, `files:write` to upload, `canvases:write`
for canvases, `reactions:write` for the 👀/✅ lifecycle on your own messages,
`im:history` for direct messages. A new scope does nothing until the app is reinstalled to the
workspace.

## Tests

```
npm test
```

198 tests over `inbox.ts`, `slackRich.ts`, `transcript.ts`, `mrkdwn.ts`,
`progress.ts` and `turn.ts`, using the Node test runner through `tsx` — no new
dependencies. `webhook.ts` opens a socket on import, so the logic worth testing
lives in those modules instead.

The turn tracker was also replayed against a real session transcript, which is
how the bug where one finished turn swallowed every later one was found — it
reported a single turn running for twenty-three minutes.

## Known limits

- The watcher only runs while a Claude session is open. Mentions arriving
  otherwise queue in the inbox and are read on the next session.
- Delivery is polled every 2 seconds.
- Markdown tables are left as pipes. Slack has no table syntax and every
  rendering of one is worse than the source.
- The progress boards a server remembers are in memory. Restarting it loses
  them; the tool then asks for the full step list rather than guessing.
- The live view reads the transcript, so it is a second or two behind and
  cannot show a partial sentence the way the terminal does. It updates when a
  block is complete.
- There is no way to interrupt Claude from Slack. Nothing in the protocol
  carries it.
- `send_slack_image` will upload any path it is given. Nothing restricts it to
  a project directory, so treat it as able to put any readable file on this
  machine into the channel.
