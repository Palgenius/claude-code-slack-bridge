# Quick reference

One page. For the full procedure see `SETUP-NEW-PROJECT.md`; for the reasoning
behind the design see `SLACK_MCP_INTEGRATION.md`.

---

## Every session

```
1. Open the project          → server connects by itself, 🟢 appears in Slack
2. Watcher should auto-start → from the project's CLAUDE.md. Not guaranteed.
3. Ask: "is slack connected?" → check the Watcher: line says RUNNING
4. If NOT RUNNING            → /slack-watch
```

**Step 3 is not optional.** A dead watcher looks exactly like nobody having
written to you: outbound still works, the channel still looks alive, and
messages pile up unread.

---

## When Slack goes quiet

| Symptom | First thing to check |
| --- | --- |
| Sent a mention, no reply | `slack_status` → `Watcher:` line |
| Every answer appears twice | `SLACK_STREAM_PROSE=1` is on — the card plus a mirror of Claude's own prose |
| Watcher running, still nothing | Its first line — a `WARNING` block means wrong inbox |
| Replies landing in the other project | Two projects, one Slack app. Expected; late not lost. |
| Channel says 🟢 but nothing responds | Orphaned server, or watcher died. `slack_status`. |
| Two status lines in the channel | The bot token is missing `chat:delete`, so the old one could not be removed |
| Nothing has ever worked | Bot not invited / scope added without **Reinstall** / tokens swapped |
| DM box is read-only, can't type to the bot | App Home → Messages Tab is off, or "allow users to send messages" is unticked |

---

## Reading `slack_status`

```
Server:  connected to Slack, pid 41580, up 59s     ← outbound is fine
Channel: C01ABCDEFGH   Project: your-project
Bot:     U0BOT123456                               ← blank = mentions can't match
Watcher: RUNNING, pid 34632                        ← THE line that matters
Unread in this channel: 0
Streaming: on (tool detail: none)
Other channels on this Slack app (they share message delivery at random):
  C02IJKLMNOP: server up, watcher down
```

---

## Starting the watcher by hand

```
Monitor({
  command: 'node "/path/to/claude-code-slack-bridge/watch-mentions.mjs" --config "<project>/.mcp.json"',
  description: 'Slack @mentions for <project>',
  persistent: true,
  timeout_ms: 3600000,
})
```

**`persistent: true` is mandatory.**

| How started | Lifetime |
| --- | --- |
| Bash `run_in_background` | 10 min, then killed |
| `Monitor` without `persistent` | 5 min, then killed |
| `Monitor` with `persistent: true` | the whole session ✅ |

The watcher polls forever, so a bounded launcher kills it mid-session and
inbound goes silently dead.

---

## Tools

| Tool | Use it for |
| --- | --- |
| `slack_status` | **First, whenever anything looks wrong** |
| `send_slack_message` | Replying. Pass `thread_ts` back. |
| `update_slack_message` | Rewriting a message in place |
| `slack_progress` | A checklist for a multi-step job, one message |
| `send_slack_image` | A screenshot or chart, inline |
| `create_slack_canvas` | Reference material that shouldn't scroll away |
| `check_slack_inbox` | Reading unread mentions manually (no watcher needed) |

---

## Terminal

```bash
# start the watcher outside Claude
node "/path/to/claude-code-slack-bridge/watch-mentions.mjs" --config "<project>/.mcp.json"

# tests
cd /path/to/claude-code-slack-bridge && npm test

# read the log for one project (every line is tagged [pid channel])
grep "C01ABCDEFGH" /path/to/claude-code-slack-bridge/slack-debug.log | tail -30

# find an orphaned server (parent-alive=False)
powershell -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -match 'preflight' } | ForEach-Object { '{0} parent-alive={1}' -f \$_.ProcessId, ((Get-CimInstance Win32_Process -Filter \"ProcessId=\$(\$_.ParentProcessId)\") -ne \$null) }"
```

---

## Log lines worth recognising

| Line | Means |
| --- | --- |
| `APP STARTED: ⚡️` | Server connected |
| `INBOX <- user: text` | A mention arrived for **this** channel |
| `ROUTED -> C0… (not ours)` | Arrived here, belongs to another project — written to its inbox |
| `slack_status: watcher=down` | Inbound is dead right now |
| `Shutting down: stdin closed` | Session exited, server exiting cleanly |
| `EPIPE: broken pipe` | An orphan writing to a dead session |
| `Ignored (no mention)` | Someone talked in the channel without @mentioning |
| `swept abandoned status line` | Corrected a 🟢 left behind by a crash |

---

## New project, minimum steps

1. `.mcp.json` in the project root with `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`,
   `SLACK_CHANNEL_ID`
2. The Slack section in that project's `CLAUDE.md` (copy from
   `SETUP-NEW-PROJECT.md` §2.2)
3. `/invite @YourBotName` in the channel
4. Restart Claude Code
5. Ask "is slack connected?"

Prefer a **separate Slack app per project** — one app shared between projects
means Slack splits incoming messages between them at random.
