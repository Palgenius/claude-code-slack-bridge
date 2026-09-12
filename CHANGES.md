## 2026-09-13 (the channel view, looked at properly)

Three problems, all visible in a screenshot of a real channel and none of them
in any test.

- **A card is no longer posted for a turn that did not earn one.** The channel
  had four of these in a row -- `Done, 0s, 707 tokens` -- naming no question,
  reporting no work, and still taking a slot each. The card is now deferred
  until the turn calls a tool, fails, or runs past ten seconds; below that the
  reply in the thread is the whole record and the channel stays quiet. A turn
  that never earned a card does not get one at the end either: by then the work
  is over and the card would only be an epitaph for something nobody watched.

- **The card says what was asked.** `Done, 35s` gives no clue which of several
  questions it answered. The prompt is carried on the turn now, shortened to a
  line and redacted like everything else, and rendered under the status.

- **A stale mention can no longer claim an unrelated turn.** `awaitingPickup`
  had no expiry, so a mention nobody acted on sat there and attached itself to
  whatever ran next -- which is how a card ended up in the channel root
  fourteen minutes after the question it claimed to answer, while the real
  reply was in a thread elsewhere. Two minutes now.

## 2026-09-13 (a status line you can actually see)

- The status line moves to the bottom of the channel when it changes, instead
  of being rewritten where it was first posted.

  Editing in place was chosen to avoid a notice per restart, and the cost did
  not show up until the channel had a day of history in it: the line keeps the
  timestamp it was first posted at, so it slides up out of view. Ours ended up
  at 23:59 with four hours of conversation below it -- to find out whether
  anything was listening you had to scroll back past the whole day. A status
  you have to go looking for is not a status.

  Exactly one line either way. The new one is posted *before* the old is
  deleted, so there is never a moment with no status at all, and a failed
  delete leaves a stale line above a correct one rather than nothing.

  `SLACK_STATUS_MODE=edit` restores the old behaviour. `SLACK_STATUS_PIN=1`
  also pins it, which is the other way to keep it reachable.

- No new scope is needed to remove the previous line: `chat.delete` runs on
  `chat:write`, which the bot already has. `pins:write` is needed only if
  pinning is turned on, and degrades to a log line if it is missing.

  (An earlier draft of this entry claimed a `chat:delete` scope. There is no
  such scope -- checked against Slack's own reference for the method, which
  lists `chat:write` for both bot and user tokens.)

## 2026-09-13 (two blocks, one answer)

- **Prose mirroring is off by default now.** With `SLACK_STREAM=1` every answer
  arrived in the channel twice: once as the reply `send_slack_message` sent,
  and once as the transcript prose behind it. Worse, that prose is what Claude
  wrote to the person at the terminal, so it carried meta-commentary
  ("Answered in the thread") that means nothing to a reader in the channel.

  The live card is the part worth having by default -- it shows the work
  happening without repeating the answer. `SLACK_STREAM_PROSE=1` brings the
  prose back, for a session where nobody is replying to Slack and the prose is
  the only visibility.

- **Markdown tables become aligned monospace blocks.** Slack has no table
  syntax and renders the source literally, so the separator row arrived as
  `| --- | --- |` and a carefully built table looked like a bug. Columns are
  padded to line up, the separator becomes a rule, and cell backticks are
  dropped since the block is already monospace.

  The rule has to run *before* inline code is parked -- a first attempt put it
  after, and every cell holding `code` rendered as a bare placeholder number.

## 2026-09-13 (documentation, and the watcher starting itself)

- Added `SETUP-NEW-PROJECT.md` and `QUICK-REFERENCE.md`, and a pointer to both
  from the README.

  `QUICK-REFERENCE.md` is one page: the session ritual, a symptom-to-cause
  table for when Slack goes quiet, how to read `slack_status`, the tools, the
  terminal commands, and the log lines worth recognising. `SETUP-NEW-PROJECT.md`
  is the full procedure for a new project, including the Slack app scopes, the
  `.mcp.json`, the `CLAUDE.md` section, and troubleshooting in the order that
  finds the problem fastest.

  Both lead with the thing that actually goes wrong: there are two processes
  and only one starts by itself. Every other piece can be working perfectly
  while inbound is dead.

- Added the Slack section to both live projects' `CLAUDE.md`. That file is read
  every session and acted on far more reliably than the MCP server's
  `instructions`, which sit in the system prompt and need a reason to be acted
  on -- proven tonight, when both sessions came up with the watcher down
  despite the instructions telling Claude to start it.

- Verified live, end to end, for the first time: a mention reached the session
  in about two seconds and was answered in-thread; a message for the other
  project was routed through the per-channel inbox and answered by the session
  that owned it; the turn card rendered `Done, 15s, 1 tool, 1.7k tokens`; and
  `slack_status` correctly reported `watcher=down` before it was started and
  `watcher=up` after.

## 2026-09-13 (a way to ask)

- Added the `slack_status` tool. Until now the only way to answer "is Slack
  actually working?" was to read `slack-debug.log` by hand and cross-reference
  a process list -- which is why a dead watcher went unnoticed three separate
  times while every individual piece was working correctly.

  It reports the one thing that actually breaks, first and unambiguously:

  ```
  Server: connected to Slack, pid 43888
  Channel: C01ABCDEFGH   Project: your-project
  Bot: U0BOT123456
  Watcher: NOT RUNNING - not running
    (warning explaining that nothing is delivering messages to this session)
  Unread in this channel: 1
  Streaming: on (tool detail: none)
  Other channels on this Slack app (they share message delivery at random):
    C02IJKLMNOP: server up, watcher down
  ```

  The other-channels section is there because two projects on one Slack app
  compete for every incoming message, and that is rarely front of mind when
  something looks broken.

- The watcher now publishes its own heartbeat (`slack-watcher-<channel>.json`)
  alongside the server's. Between the two, "is anything connected" and "is
  anything listening" are separate, answerable questions rather than one
  inference from a log.

## 2026-09-13 (why the watcher kept dying)

- Root cause found for three evenings' worth of "inbound is broken": the
  watcher was being started as a **Bash background task**, which is capped at
  ten minutes. A non-persistent Monitor is capped at five. The watcher polls
  forever, so whichever bounded mechanism started it killed it part-way through
  the session -- and from then on messages kept arriving in the inbox correctly
  while nothing surfaced them.

  Every symptom pointed somewhere else each time: a stale watcher on the wrong
  inbox file, then no watcher at all, then messages that had plainly been
  delivered with no reply. The mechanism was never the config; it was the
  lifetime.

  The only thing that lasts a whole session is `Monitor` with
  `persistent: true`, which the tool documents as running until the session
  ends. The server's instructions now give that exact call and say explicitly
  not to use Bash `run_in_background` or a bounded Monitor.

## 2026-09-13 (starting the watcher)

- The watcher reads the bot id and the channel out of `--config`, so the whole
  command is now `node watch-mentions.mjs --config <project>/.mcp.json`. That
  file already names both; a command that has to be assembled by hand is one
  that does not get run, which is precisely what kept happening -- three
  separate times tonight a test looked like a total failure when in fact every
  message had arrived correctly and nothing was watching the inbox.

  The bot id is resolved through `auth.test` when it is not given.

- The MCP server now spells that command out in its `instructions`, which go
  into Claude's system prompt, including the project's own config path and
  channel. Telling the person to remember it had failed three times; telling
  the model, every session, is the fix.

## 2026-09-13 (watcher version mismatch)

- `watch-mentions.mjs` now says so, loudly, when it is watching a file nothing
  writes to any more.

  The inbox moved from one shared `slack-inbox.jsonl` to one file per channel.
  A watcher started before that change keeps polling the old file forever:
  messages arrive correctly, get written to the per-channel file, and the
  watcher reports nothing. The silence is indistinguishable from nobody having
  said anything -- and it went unnoticed for exactly that reason, with two
  stale watchers polling a file that had not been written to in an hour while
  the routing underneath them worked perfectly.

  Starting without `--channel` while per-channel inboxes exist now prints a
  warning naming the files and saying what to do about it.

## 2026-09-13

- The status line no longer depends on the dying process to tell the truth.

  Writing "offline" during shutdown covers a session being closed -- stdin
  closing does reach the server -- but it covers nothing else. A force-kill, a
  crash or the machine losing power runs no handler at all, and the channel
  then claims to be listening indefinitely. That is the worst failure this
  feature has: a green line that is wrong is more damaging than no line,
  because it is the one thing somebody checks before deciding the silence means
  Claude is busy rather than absent.

  So no process is trusted to announce its own death. Every server sweeps, on
  each heartbeat, for status lines that still say connected while the
  corresponding heartbeat has stopped, and corrects them. They all share one
  directory, so whichever session happens to be running cleans up after the
  ones that are not -- including for projects it knows nothing about. A status
  file with no heartbeat beside it counts as abandoned, since only a version
  that writes heartbeats writes status files.

  The swept line is recorded as offline whether or not the edit succeeded,
  because a message that cannot be edited must not be retried every fifteen
  seconds for the life of the session.

## 2026-09-12 (presence)

- The channel now says whether anything is listening. On connecting the server
  posts one line -- green, the project name, since when -- and rewrites that
  same line to grey when the session ends.

  Without it a quiet channel and a dead one are indistinguishable: you write a
  message, nothing answers, and the bridge being down looks exactly like Claude
  being busy.

  One message, edited, rather than a notice per startup. Sessions restart
  often, and a channel filling with "connected... connected... connected" is
  worse than no signal at all -- each line is stale the moment the next one
  lands and none of them states the current position. The message timestamp is
  kept on disk, keyed by channel, so a restart finds the line it posted last
  time and edits it in place; if that edit fails, because the message was
  deleted, it posts a fresh one and remembers that instead.

  A shutdown never posts a *new* offline line -- there is nothing useful in
  announcing a departure nobody saw arrive -- and the offline write is bounded
  at three seconds, since it runs while the session is already tearing down.

  `SLACK_ANNOUNCE=0` turns it off. The project name comes from the working
  directory, or `SLACK_PROJECT_NAME`.

## 2026-09-12 (orphans)

- **Why orphans happen, established by experiment rather than reading.**
  Windows has no process-group kill: when a Claude session dies nothing signals
  its descendants, and the spawn chain is five deep --
  `claude -> cmd -> npx -> cmd -> tsx -> node`. The one signal that does reach
  the bottom is stdin closing.

  Two runs of the same spawn chain, killing the parent the way a crashed
  session would:

  | Child | Result |
  | --- | --- |
  | no stdin reader | survived indefinitely, no shutdown |
  | MCP `StdioServerTransport` reading stdin | `SHUTDOWN: stdin end`, exited in about a second |

  So `webhook.ts` is genuinely fixed: the MCP transport reads stdin, which is
  what makes the handler fire. The orphan found on this machine started before
  that fix landed.

- **`watch-mentions.mjs` was the unfixed case, and it is the worse one.** It
  runs with stdin at `/dev/null` and polls on a timer, so nothing ever tells it
  to stop: every session left one behind, still polling every two seconds and
  still downloading attachments, for as long as the machine stayed up. One had
  been running for three hours.

  The server now writes a heartbeat file, and the watcher exits when the beat
  stops. The server's own lifetime is already tied to the session, so its
  heartbeat is a reliable proxy. The file is never deleted on shutdown --
  absence would be ambiguous between "the server stopped" and "no server has
  ever run for this channel", where staleness says the first unambiguously --
  and it is written to one side and renamed, so a reader cannot catch it empty
  mid-write and exit for no reason. The watcher acts on it only after seeing
  one live beat, so a watcher started before its server does not exit at once.

## 2026-09-12 (multi-project fixes)

Found by looking at a machine actually running two projects against one Slack
app, rather than by reading the code.

- **One inbox and one cursor per channel.** Every project points its config at
  the same `webhook.ts`, so `new Inbox(HERE)` resolved to the same two files
  for all of them. Whichever session called `check_slack_inbox` first read the
  other project's messages *and marked them read*, and the session they were
  meant for never saw them. Keyed on the channel now, because that is the one
  identifier the server receiving a message and the session that wants it can
  agree on without being told.

- **A message for another channel is routed, not dropped.** Slack hands each
  message to one randomly chosen connection, so with two projects running,
  roughly half of each one's messages arrived at the wrong server -- which
  compared `SLACK_CHANNEL_ID`, found a mismatch, and `return`ed silently with
  no record anywhere. The check now runs after the subtype and mention filters,
  and what survives is appended to the inbox of the channel it belongs to. The
  session that owns that channel finds it on its next read: late, rather than
  lost. The shared filesystem does the routing the socket will not.

  The silence was the worst part of it -- the loss rate could not even be
  measured, because the discard path logged nothing.

- **Every log line carries its pid and channel.** One log file is shared by
  every server on the machine. Three processes interleaving into it with
  nothing to tell them apart is why it read as noise, and it is why an orphan
  had been running unnoticed for three hours. Subtype and no-mention lines are
  now logged only for a server's own channel, since every server sees every
  channel's events and the live card's own edits come back as
  `message_changed`.

- `watch-mentions.mjs` takes `--channel`, reading that channel's inbox and
  filtering the legacy shared file by channel too.

- Existing entries in the shared `slack-inbox.jsonl` were migrated into their
  channel's file, with the cursor set past them: they are historical and had
  already been acted on, and resurfacing them would have had a session redo
  finished work. `check_slack_inbox` with `peek: true` still shows them.

## 2026-09-12 (live view)

- The channel now shows Claude working, instead of a log being copied into it.

  The old streamer posted each block as it appeared: disconnected fragments
  with no beginning, no end and nothing in between. The terminal does not feel
  like that because it has a *turn* -- you ask, something visibly works, an
  answer arrives -- and that structure was already in the transcript and simply
  was not being read. A `user` entry whose content is a plain string is
  somebody asking; `stop_reason: "tool_use"` is work continuing;
  `stop_reason: "end_turn"` is the answer finished; `user` entries holding
  `tool_result` are the work coming back, and carry `is_error` when a step
  failed.

  `turn.ts` reads that and renders one card per turn that rewrites itself:
  a status line that ticks with elapsed time, tool count and tokens, the most
  recent tool calls beneath it, and -- once the turn ends -- the list of files
  it changed in place of the activity, because by then what was done matters
  more than the order it happened in. Claude's prose arrives underneath as
  separate messages in the same thread.

- Everything for a turn goes in one thread, and the asker's own message gets an
  eyes reaction while it runs and a tick (or a warning if a step failed) when it
  finishes. A question nobody picked up is now obvious without reading anything.
  Needs `reactions:write`.

- `SLACK_STREAM_TOOLS` gained a `detail` level, off by default. It shows a
  short target next to the tool name using only fields written to be read: the
  one-line `description` Bash and the agent tools carry, the basename of a file
  path, a search pattern. Never a command string, never file content, never the
  code around a match -- and all of it through the same redaction as the prose.
  Using the `description` rather than the command is the reason this is
  possible at all: it is both safer and more readable than anything that could
  be derived from the command itself.

- Fixed a bug the fixtures could not have found. Not every turn is announced by
  a string-content `user` entry -- a queued message or a continuation is not --
  so a finished turn kept absorbing everything after it. Replaying a real
  session transcript reported one turn running for twenty-three minutes with
  eighty-nine tool calls, and fired `end` again each time another turn ended.
  An `assistant` entry arriving after `end_turn` now starts a new turn.

- `TranscriptTailer` grew `nextEntries()` for whole parsed entries; `next()`
  keeps its old shape and both now share one read, so the byte offset advances
  once however it is consumed.

- 198 tests now, over six modules. The turn tracker is also replayed against a
  real transcript, which is how the bug above was found.

## 2026-09-12 (later)

- Added `slack_progress`: a checklist kept to one message that rewrites itself
  as the work moves. Post it once with `steps`, then move it with
  `advance: true` between stages or `update: [{step, status}]` for a specific
  one, where `step` is an index or any substring of that step's text. Pending
  and active share an icon on purpose -- the bold on the active line is what
  separates "running" from "waiting", and reads at a glance in a way two
  similar icons do not.

  `advance` exists because the commonest way to get a board wrong is marking a
  step done and forgetting to start the next one, which leaves the checklist
  looking stalled. Boards live in memory keyed by `ts`; if the server has
  restarted the tool says so and asks for the full list rather than rewriting
  the message with a board that has silently lost its history.

- Added `mrkdwn.ts`: Claude writes GitHub-flavoured markdown and Slack renders
  the difference literally, so every message this bot sent was arriving with
  its asterisks showing and `[text](url)` spelled out in full. Code is parked
  before any rule runs and restored at the end -- a converter that rewrites the
  asterisks inside a code sample is worse than no converter.

- Replies go into threads. `thread_ts` is carried through the inbox, the
  watcher and the channel notification, and every sending tool takes one. An
  answer now sits under the question instead of at the top of the channel.

- A long message is split rather than truncated. Cutting at 3900 characters
  kept the message and lost the conclusion. It now splits on line boundaries,
  never inside a fenced code block -- an unclosed fence renders the rest of the
  channel as code -- and threads the continuation off the first part so a long
  answer stays one item in the channel. An edit still truncates: there is only
  one message to rewrite.

- Direct messages work, with `im:history` and the `message.im` event. A DM is
  addressed to the bot by definition; requiring an `@mention` in one is asking
  someone to say a name into an empty room. `SLACK_CHANNEL_ID` does not filter
  them out, since that setting is about which channel to listen in and a DM is
  not one.

- Stripping the `@mention` no longer flattens the message. It ran `\s+` over
  the whole text, so a pasted stack trace, numbered list or code block reached
  Claude as one run-on line. Only the space around the removed token is
  collapsed now.

- The inbox deduplicates by `ts`. Socket Mode redelivers on reconnect and
  several instances append at once, so the same message genuinely lands in the
  file twice -- and `check_slack_inbox` was handing Claude the same instruction
  twice in a row.

- The server exits when its session does, on stdin closing, SIGTERM/SIGINT, or
  the MCP transport closing. An orphan kept its Slack socket and Slack
  load-balanced messages onto a dead pipe, where they vanished with no error
  anywhere; the documented fix was to hunt the process down by hand.

- Missing or swapped tokens are named at startup. The first symptom used to be
  `invalid_auth` on a tool call or a socket that simply never connected,
  neither of which says which variable was left out of the config.

- The log and the inbox rotate at 4MB, keeping one generation. Both were
  append-only with no bound. `Inbox.all()` reads the rotated generation too, so
  rotating cannot drop a mention nobody had read yet.

- The stream queue is bounded at 200 blocks. A busy session writes faster than
  Slack accepts for as long as it runs, so an unbounded queue ends up narrating
  something that finished ten minutes ago. The oldest are dropped and the count
  is posted. `SLACK_STREAM_THREAD` put the whole stream in one thread; the
  live view below replaced it, since threading is now per turn and needs no
  configuring.

- `npm test` was running two of the three test files, so the redaction tests --
  the ones guarding against posting a secret to a channel -- were not running
  on `npm test` at all. Now 153 tests across five modules.

- `.gitignore` now covers the inbox, the cursor, `attachments/`, the rotated
  logs and `*.bak-*`. The inbox and five downloaded images were sitting
  untracked in the repository, one `git add .` from being committed.

## 2026-09-12

- Added line-by-line streaming of Claude's own messages into the channel,
  **off by default** behind `SLACK_STREAM=1`.

  Claude Code has no outbound channel: `notifications/claude/channel` carries
  Slack to Claude and has no counterpart going back, confirmed by searching the
  binary. But it writes the whole session to
  `~/.claude/projects/<project>/<session-id>.jsonl` as it goes, so following
  that file achieves the same thing without the platform needing a feature. The
  session id comes from `CLAUDE_CODE_SESSION_ID`, so this works in any project
  with no per-project setup.

  `transcript.ts` enforces two rules structurally rather than by a later
  filter: `thinking` blocks have no path to the output at all, and everything
  else is redacted on the way out -- `pass=`, Slack tokens, connection strings,
  bearer headers, private keys, long hex runs. This matters because Claude's
  prose quotes files and command output: during the session this was built in,
  it printed a database password from an Apache config, and an unredacted
  streamer would have posted it to the channel. Verified against the real
  transcript: the password is present in the file and absent from the output.

  Off by default deliberately. Forwarding a session transcript to an external
  service is a decision for whoever owns the workspace, made in their own
  config -- not something switched on by whoever wrote the code.

  Posts are queued and drained at roughly one per second, because that is
  chat.postMessage's rate limit per channel and one reply can hold several
  blocks.

- Added `update_slack_message`, and `send_slack_message` now returns the
  message timestamp. Together they give a live status marker: post "working on
  X", rewrite that same message as the work moves, rewrite it once more when it
  is done. One line in the channel that changes, rather than a scroll of
  half-finished progress reports -- which is what asking for a "Claude is
  working" indicator actually needs.

  `send_slack_message` is routed through `postMessage` in slackRich now rather
  than calling app.client directly, so it comes back with the timestamp and so
  an over-long message is truncated. Slack rejects anything past 4000
  characters outright, losing the whole message rather than the tail.

- Incoming Slack messages never reached Claude. The server was not at fault:
  it forwarded every one correctly. Claude Code delivers
  `notifications/claude/channel` only when its session was started with
  `--channels`, which the Claude desktop app does not pass, so a capability
  gate accepted each notification and dropped it — with no error in this log,
  in Slack, or on screen. Proven by a run where the log read
  `Received: 4 / Forwarded: 4 / EPIPE: 0 / MCP Error: 0` while none of the four
  messages arrived.

  Mentions are now also appended to `slack-inbox.jsonl`, and
  `watch-mentions.mjs` turns each new one into a line on stdout. Run under a
  Claude Code Monitor, every line becomes an event in the session, which is how
  a Slack message reaches Claude without the flag. The watcher also reads an
  older instance's `slack-debug.log`, so it works while a session started
  before this change is still running.

- Only messages that `@mention` the bot are collected, so the channel stays
  usable for ordinary conversation without waking Claude.

- Fixed the subtype filter. The original skipped only `bot_message`, so
  huddle-started and message-edited events were forwarded with empty text.
  Blanket-skipping every subtype was worse and briefly shipped: it threw away
  every message with an image attached, because those arrive as `file_share`.
  `file_share` and `thread_broadcast` are now kept — both are a person typing.

- Added `check_slack_inbox`, `send_slack_image` and `create_slack_canvas`.
  Uploading is the three-step `getUploadURLExternal` → PUT →
  `completeUploadExternal` sequence, because `files.upload` is deprecated and
  now refuses. A canvas tries the channel canvas first and falls back to a
  standalone one shared into the channel, since a channel holds only one.

- Anchored `slack-debug.log` and the inbox to this directory. They were written
  with bare relative paths, so they landed in whatever directory the session
  happened to start in.

- Added 42 tests over `inbox.ts` and `slackRich.ts` via the Node test runner
  through `tsx`, with no new dependencies. `webhook.ts` opens a socket as soon
  as it is imported, so the logic worth testing was moved into those two
  modules. `slackRich.ts` takes `fetch` and `fs` as injected dependencies so
  the call sequences can be checked without a Slack workspace.

- The original server is kept as `webhook.ts.bak-20260912-183246`.
