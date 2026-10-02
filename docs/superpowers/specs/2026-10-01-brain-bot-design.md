# Brain bot: Telegram access to the second-brain store

- **Status:** design approved by the owner on 2026-10-01. The implementation plan comes next.
- **Repos:** `telegram-bot` (this repo: the bot) and `plessas-second-brain` (the store and its MCP
  server). Both are public, so nothing in this document or in the code may name the owner's
  employer, colleagues or data. Owner-specific text lives in private files on the host (6.6).
- **Host:** the always-on Linux VPS that already runs the general bridge and owns the master
  `brain.db`.

## 1. Goal

From Telegram, by text or voice, the owner asks questions that the second-brain store can answer
(mail, attachments, calendar, Teams, WhatsApp, SharePoint links, past Claude Code conversations),
with the news archive and the public web as secondary sources. Follow-up questions keep the
context of the subject. When a subject is done, one command or one tap closes it and the next
question starts clean.

### Success criteria

1. A follow-up that depends on the previous answer ("who replied?", "open the second one") is
   answered without restating the subject.
2. `/new` or the 🆕 button closes the subject, and the next answer shows no trace of it.
3. Something visible appears within 2 s of sending: the draft placeholder.
4. Median time to a complete answer stays under 30 s on the smoke set. This is a target to
   measure, not a promise.
5. No tool outside the allowlist in 6.1 ever runs, whatever the corpus content says.
6. With the brain service down, the bot says so. It never answers from nothing.
7. The general bridge bot behaves exactly as before.

## 2. Decisions (owner, 2026-10-01)

| Question           | Decision                                                                                                                                                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shape              | A dedicated bot on this repo's bridge code, run as its own systemd unit. Rejected: upgrading the general bridge bot (47 plugins per turn, send-capable tools beside untrusted mail) and a Python bot inside second-brain (rebuilds Telegram, voice and the agent loop). |
| Telegram retention | Keep everything. Closing a subject clears the model context; no Telegram message is deleted.                                                                                                                                                                            |
| Reach              | The second-brain MCP tools, a new read-only SQL tool, the news-reader MCP, and web search.                                                                                                                                                                              |
| Embeddings         | Reached through existing tools (6.1). No new embedding tool.                                                                                                                                                                                                            |

## 3. Facts this design rests on (measured 2026-10-01)

- **General bridge today.** Every message is a fresh turn (`resume: null`) against one global
  state file. It loads 47 plugins per message under `bypassPermissions`. It has served 13 turns
  since August: median 34 s, p90 161 s, worst 1,179 s. Its unit is capped at `MemoryMax=2G`.
- **second-brain MCP server.** It serves stdio only (`mcp.run()`). The installed `mcp` 2.2.0
  `MCPServer` also serves `streamable-http`: `streamable_http_app()` returns a Starlette app, and
  `uvicorn` is installed.
- **Embedding index.** 132,958 vectors of 3,072 floats (Mac replica count), about 1.6 GB in
  memory per process. It is cached by file mtime and reloaded when `embeddings.npz` changes. Query
  embeddings go to Vertex through ADC (`VERTEX_REGION_EMBED`).
- **MCP write paths.** The only one is the `sharepoint_index` refetch, which refuses when
  `is_replica()` holds (`BRAIN_ROLE=replica`). No read path consults the role.
- **Conversation ingest.** The producer indexes every `~/.claude/projects/*/**/*.jsonl`. A bot
  that writes its transcripts there feeds its own answers back into the store.
- **VPS.** 4 vCPU, 7.6 GiB RAM, about 6.5 GiB available. Nothing listens on loopback port 8765.
- **Telegram Bot API** (grammy 1.46, types 5.0.0):
  - Bots can have topics in private chats (`has_topics_enabled`, `allows_users_to_create_topics`,
    `message_thread_id`).
  - `sendMessageDraft` streams an ephemeral preview that lasts 30 s after its last update, with
    an optional Stop button (`can_stop`, update `stopped_message_generation`).
  - Messages hold at most 4,096 characters.
- **Agent SDK** (0.3.28x):
  - Sessions: `sessionId` (a caller-chosen UUID), `resume`, `getSessionInfo` (undefined when the
    transcript is missing or unreadable) and `deleteSession`.
  - Tools: `tools` (the built-in set, `[]` for none), `allowedTools`, `permissionMode: 'dontAsk'`
    (deny anything not pre-approved), `strictMcpConfig`, and `mcpServers` entries of
    `type: 'http'` with `headers` and `alwaysLoad`.
  - Other options: inline `settings` (`promptCacheTtl: '1h'`, `cleanupPeriodDays`),
    `includePartialMessages`, `maxTurns`.
  - The `system/init` message lists each MCP server with its `status`.

## 4. Architecture

```text
Telegram app ──Bot API──▶ telegram-brain.service     (this repo, brain profile)
                            │ one Agent SDK turn per message
                            │ CLAUDE_CONFIG_DIR=~/.telegram-brain/claude
                            ├──▶ sb-mcp.service       http://127.0.0.1:8765/mcp, bearer token
                            ├──▶ news-reader          stdio, spawned per turn
                            └──▶ WebSearch            built-in, server-side
sb-mcp.service ──▶ brain.db (master, WAL) + embeddings.npz     (second-brain repo)
```

### 4.1 `sb-mcp.service` (second-brain)

- Runs `python -m src.mcp_server --http 127.0.0.1:8765`. Without `--http` the module serves stdio
  exactly as today, so every existing client is unchanged.
- Every request needs `Authorization: Bearer <token>`. The token comes from the file named by
  `BRAIN_MCP_TOKEN_FILE` (mode 0600) and is compared in constant time. A missing or wrong token
  gets 401. With `--http` and no readable token file, the server refuses to start.
- Binds loopback only, and keeps the SDK's transport security (Host and Origin checks) on.
- Runs with `BRAIN_ROLE=replica`, so the refetch writer refuses even though the master DB sits next
  to it.
- Uses the same environment as the other `sb-*` units: the Vertex env file for query embeddings,
  and `outlook-cli` on `PATH` for `outlook_live_search`.
- `Restart=always`, `OnFailure=notify-failure@%n.service`, `MemoryMax=4G`. One index takes about
  1.6 GB, and a reload briefly holds two.
- The repo archives the wrapper the unit runs, `scripts/wrappers/systemd/sb-mcp.sh`. The unit text
  itself is in `docs/DEPLOY.md`, section 9; there is no archived unit file.

### 4.2 `telegram-brain.service` (this repo)

- The existing bridge process, started with the brain profile: its own env file, bot token and
  state path, no plugins, no MTProto channel.
- The unit sets `CLAUDE_CONFIG_DIR=~/.telegram-brain/claude` for the whole process, so the SDK
  subprocess and the SDK's session helpers (`getSessionInfo`, `deleteSession`) agree on where
  transcripts live, outside `~/.claude/projects`.
- Model and region come from the operator's Vertex env file, exported by the unit the way the
  general bridge unit does it.
- `Restart=always`, `OnFailure=notify-failure@%n.service`, `MemoryMax=1500M`.
- An example unit ships at `bridge/systemd/telegram-brain.service.example`. Today the repo ships
  no systemd recipe at all.

### 4.3 One message, end to end

1. grammy receives the update. It is dropped unless the sender is allowlisted and the chat is
   private.
2. Slash commands and button taps are handled inline (5.3).
3. The bot resolves the subject key (5.1) and queues the message behind that subject's previous
   one.
4. A draft placeholder ("Thinking…") with a Stop button appears.
5. One SDK turn runs: `sessionId` for a new subject, `resume` for an existing one (5.2).
6. On `system/init`, the bot checks that `second-brain` reports `connected`. If not, it aborts and
   replies that the brain is offline.
7. Tool calls become progress lines in the draft, and text deltas become the draft text (5.4).
8. On the result, the bot sends the final answer as normal messages (formatted, split, 🆕 button on
   the last one), stores the session ID the result reports, and appends the exchange to the
   subject log.

## 5. Conversation model

### 5.1 Subjects

- A subject is one Claude session plus a small record: `sessionId`, `title` (the first question,
  cut to 60 characters), `createdAt`, `lastActiveAt`, `questions`, and a log of the last 10
  exchanges with answers cut to 2,000 characters.
- The key is `chatId:threadId`, with `threadId` 0 outside topics. With Threaded Mode off in
  BotFather there is one subject per chat. With it on, each topic is its own subject, and several
  can be open at once.
- Records live in `~/.telegram-brain/subjects.json`, mode 0600, written atomically (tmp then
  rename) like the existing `StateStore`.

### 5.2 Session lifecycle

- **New subject.** Generate a UUID and pass it as `sessionId`.
- **Follow-up.** Confirm the transcript exists with `getSessionInfo`, then pass the stored ID as
  `resume`. After the turn, store the `session_id` the result reports, which is correct whether or
  not the SDK forked the session.
- **Only real turns count.** A turn that produced no text and cost nothing never replaces the
  stored ID. Storing such IDs caused the general bridge's "No conversation found" cascade.
- **Rebuild when resume is impossible.** If the transcript is missing, or a resumed turn fails with
  a missing-session error, the bot starts one new session seeded with the subject log ("Earlier in
  this subject: Q1, A1, ...") and prefixes the answer with "(context rebuilt from the chat log)".
- **Idle notice.** If the subject has been idle for more than 6 h, the answer opens with
  "(continuing «title», idle N h · /new to start fresh)". Context is never dropped silently.
- **Close.** Deletes the subject record and its SDK transcript (`deleteSession`). After a close the
  bot keeps no copy of the subject on the host.
- **Prompt cache.** `settings.promptCacheTtl = '1h'`, so follow-ups within the hour reuse the
  cached context. Transcripts of subjects never closed are swept after 30 days
  (`cleanupPeriodDays: 30`), and such a subject then resumes through the rebuild path.

### 5.3 Commands and buttons

| Input                          | Effect                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `/new`, `/clear`, 🆕 button    | Close the subject of this chat or topic. Reply "closed: «title», N questions". |
| `/context`                     | Title, question count, age, idle time, context tokens of the last turn, model. |
| `/voice [mirror\|always\|off]` | As today.                                                                      |
| `/help`                        | This list.                                                                     |

Commands are registered with `setMyCommands`, so they appear in the Telegram menu. The 🆕 button
carries its subject key, so a tap in one topic never closes another.

### 5.4 Streaming

- With `includePartialMessages: true`, text deltas update the draft, and each `tool_use` adds a
  progress line such as "🔎 recall: budget 2027" (the tool name and the first 40 characters of its
  main argument).
- At most one draft update per second. During a long tool call the draft is refreshed every 15 s
  with the elapsed time, because a draft vanishes 30 s after its last update.
- Stop (`stopped_message_generation`) aborts the SDK turn. The bot replies "stopped" and keeps the
  subject.
- The final answer always goes out through `sendMessage`. Drafts are previews only.

### 5.5 Formatting

- The base prompt asks for Telegram-friendly output: short paragraphs, bullets, no tables, bold
  lines instead of headings.
- A small converter maps the Markdown subset (bold, italic, inline code, code blocks, links,
  bullets) to Telegram HTML and escapes everything else. If Telegram rejects the entities, the same
  chunk is resent as plain text.
- Text is split on paragraph boundaries before conversion, at most 3,500 source characters per
  chunk, so no tag straddles two messages.

### 5.6 Replies

When the owner replies to an earlier bot message, the first 500 characters of the quoted message
are prepended to the question as `[Replying to: «…»]`.

### 5.7 Voice

Unchanged: Speech-to-Text in, optional Text-to-Speech out, `/voice` modes as today.

### 5.8 Concurrency

Messages within one subject run in order, and at most two turns run at once across subjects. The
general bridge keeps its single FIFO queue.

## 6. Tools and safety

### 6.1 Tool set

| Source                  | Tools                                                                |
| ----------------------- | -------------------------------------------------------------------- |
| second-brain MCP (HTTP) | The 25 existing tools, plus `sql_query` and `sql_schema` (6.3).      |
| news-reader MCP (stdio) | `search_news`, `digest_history`, `news_stats`, `recent_for_tickers`. |
| Built-in                | `WebSearch`.                                                         |

Nothing else loads: no `WebFetch`, `Bash`, file tools, plugins, subagents or send tools.

Embeddings are reached through existing tools. `recall` blends keyword and semantic ranking, and
`search_emails` with `search_type="semantic"` ranks the whole index (emails, attachments, Teams
threads, WhatsApp threads, Claude conversations) despite its name. The base prompt sends fuzzy
questions there, and exact names, numbers and dates to keyword search or SQL.

### 6.2 Enforcement

1. **What loads.** `tools: ['WebSearch']`, `strictMcpConfig: true` with exactly two `mcpServers`,
   `plugins: []`, `settingSources: []`. The second-brain entry sets `alwaysLoad: true`, so its
   tools are always in the prompt and the `system/init` status reflects a real connection attempt,
   and a 90 s per-call `timeout`, so a hung tool fails before the 120 s silence watchdog (7).
2. **Each call.** `permissionMode: 'dontAsk'` with `allowedTools` set to the exact names in 6.1.
   Anything else is denied. Never `bypassPermissions`. On each `system/init` the bot compares the
   reported tool names with the allowlist and logs a warning for any server tool missing from it,
   and it logs every entry of `result.permission_denials`, so a newly added tool is noticed rather
   than silently allowed or silently refused.
3. **Server side.** The brain service refuses writes (`BRAIN_ROLE=replica`), and `sql_query`
   cannot write (6.3).
4. **Budget.** `maxTurns: 25` per message.

### 6.3 `sql_query` and `sql_schema` (second-brain)

- `sql_schema(table: str | None = None)`: without a table, every table with its row count; with
  one, its columns, types and indexes.
- `sql_query(sql: str, limit: int = 200)`:
  - Opens its own connection with `mode=ro`, adding `immutable=1` only where no writer runs: the
    Mac replica, where a plain read-only open fails with error 14. The choice follows the replica's
    pull stamp, not `BRAIN_ROLE`, because the VPS service sets `BRAIN_ROLE=replica` beside a live
    database.
  - Sets `PRAGMA query_only = ON` and installs a SQLite authorizer that allows only `SELECT`,
    `READ` and function calls. `ATTACH`, writing `PRAGMA`s and every DML or DDL statement are
    denied.
  - Runs one statement per call, within a 10 s budget enforced by a progress handler. Returns at
    most `limit` rows (capped at 200) and cuts each cell to 4,000 characters, saying when it
    truncated.
  - Registers the same custom SQL functions as `get_connection`, accent folding among them.
- The tools live in the MCP server, so the owner's Mac sessions gain them too. Beyond aggregates,
  their main use is reading full bodies (`emails.content`, `teams_messages.content_text`,
  `attachment_content.extracted_text`), which the other tools only summarise.

### 6.4 Untrusted content

Everything a tool returns is third-party content. With no tool that sends, writes or fetches a URL,
a hostile email can at worst distort an answer or steer a web search. The base prompt says so, and
forbids personal names, internal project names and any non-public detail in `WebSearch` queries.

### 6.5 Access

- `TELEGRAM_BRIDGE_ALLOWED_SENDER_IDS` holds the owner's user ID only, and non-private chats are
  ignored.
- Anyone inside the owner's Telegram account can query the store, so the account's two-step
  verification password is a prerequisite.
- The bot token and the MCP bearer token live in 0600 files on the host, never in git.

### 6.6 Prompts

- **Base prompt** (`bridge/src/brain/prompts/brain-base.md`, generic): a retrieval assistant over
  the owner's store; tool routing; up to five sources per answer (kind, who, date, subject);
  Telegram formatting; answers in the language of the question; the untrusted-content and
  web-search rules (6.4); and "check the `stats` coverage before saying something did not happen".
- **Persona file** (private, on the host, path in `TELEGRAM_BRIDGE_SYSTEM_PROMPT_FILE`): who the
  owner is and the organisational context. It is appended to the base prompt at start-up, and the
  brain profile refuses to start without it.
- Both go in as a custom `systemPrompt` string, replacing the Claude Code coding prompt, which the
  bot does not need.

### 6.7 Data handling

- Telegram keeps the full chat history (owner decision). Bot chats are not end-to-end encrypted, so
  the owner records this copy in their private data register at rollout (11.5).
- SDK transcripts live under `~/.telegram-brain/claude`, out of reach of the conversation ingest.
  Closing a subject deletes its transcript; the rest are swept after 30 days.
- Subject records are deleted when the subject closes.

## 7. Failure handling

| Failure                     | Detection                                                      | Response                                                |
| --------------------------- | -------------------------------------------------------------- | ------------------------------------------------------- |
| Brain service down          | `system/init` shows `second-brain` not `connected`             | Abort the turn and reply "brain offline (sb-mcp)".      |
| Transcript missing          | `getSessionInfo` returns undefined, or a missing-session error | One rebuild from the subject log (5.2).                 |
| SDK silent                  | The existing watchdog, lowered to 120 s for this profile       | Retry once in a fresh session, then report.             |
| Vertex 429, auth, refusal   | The existing retry and refusal fallback                        | Report the cause in one line.                           |
| Runaway agent loop          | `maxTurns: 25`                                                 | Send the answer so far, noting that it hit the limit.   |
| Telegram rejects formatting | HTTP 400 on send                                               | Resend that chunk as plain text.                        |
| Stop pressed                | `stopped_message_generation`                                   | Abort, reply "stopped", keep the subject.               |
| Index reload                | `embeddings.npz` mtime changed                                 | The next semantic query waits for the reload (seconds). |

## 8. Configuration (brain profile)

| Variable                                          | Purpose                                                                                                                |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `TELEGRAM_BRIDGE_PROFILE=brain`                   | Selects the behaviour in this document. Unset or empty keeps today's general bridge; any other value refuses to start. |
| `TELEGRAM_BOT_TOKEN`                              | The brain bot's token, from a new BotFather bot.                                                                       |
| `TELEGRAM_BRIDGE_ALLOWED_SENDER_IDS`              | The owner's user ID (6.5).                                                                                             |
| `TELEGRAM_BRIDGE_STATE_PATH`                      | `~/.telegram-brain/subjects.json`.                                                                                     |
| `TELEGRAM_BRIDGE_BOT_TMPDIR`                      | Optional: where voice notes download. Default `inbox` beside the state file.                                           |
| `TELEGRAM_BRIDGE_SYSTEM_PROMPT_FILE`              | The private persona file.                                                                                              |
| `CLAUDE_CONFIG_DIR`                               | `~/.telegram-brain/claude`, set by the unit for the whole process.                                                     |
| `TELEGRAM_BRIDGE_CWD`                             | Optional: the SDK's working directory, created if missing. Default `CLAUDE_CONFIG_DIR`.                                |
| `BRIDGE_BRAIN_MCP_URL`                            | `http://127.0.0.1:8765/mcp`.                                                                                           |
| `BRAIN_MCP_TOKEN_FILE`                            | The bearer token file, shared with `sb-mcp.service`. Read once, never logged.                                          |
| `BRIDGE_NEWS_MCP_COMMAND`                         | Path to the news-reader MCP launcher.                                                                                  |
| `TELEGRAM_LOG_LEVEL`                              | Optional; default `info`.                                                                                              |
| `ANTHROPIC_MODEL` and the other Vertex vars       | The model and region of every turn, passed to the CLI in its environment; `/context` names the model.                  |
| `VERTEX_MODEL_FALLBACK`, `VERTEX_REGION_FALLBACK` | The refusal retry's model and region, with the general bridge's defaults.                                              |
| The seven voice vars                              | As documented in the README.                                                                                           |

The brain branch runs before `loadConfig()`, so the MTProto variables are neither read nor
required, and `TELEGRAM_BRIDGE_DISABLE_SAVED_MESSAGES` does not apply. The example unit points
dotenv at the brain's env file (`DOTENV_CONFIG_PATH`), so the repo's `.env` never fills its gaps.

## 9. Changes by repo

### plessas-second-brain

- `src/mcp_server.py`: the `--http HOST:PORT` entry, the bearer middleware, and the `sql_query` and
  `sql_schema` tools.
- `src/store/sql_readonly.py` (new): the read-only connection, authorizer, budget and caps.
- `scripts/wrappers/systemd/sb-mcp.sh` (new): the wrapper `sb-mcp.service` runs. The unit itself
  is in `docs/DEPLOY.md`.
- `README.md`, `CLAUDE.md` and `docs/DEPLOY.md`: the HTTP mode, the token file, the new tools.
- Tests: `tests/test_mcp_http.py`, `tests/test_sql_readonly.py`.

### telegram-bot

The brain's modules live in `bridge/src/brain/`:

- `profile.ts` (new): reads and validates the brain profile, refuses an unknown
  `TELEGRAM_BRIDGE_PROFILE`, and builds the SDK options (tools, MCP servers, allowlist, prompt,
  settings).
- `subjects.ts` (new): the subject store and keying.
- `turn.ts` (new): one turn through the Agent SDK's `query`: the session lifecycle, the MCP status
  gate, the rebuild path, the single retries, stream events.
- `draftStream.ts` (new): throttled `sendMessageDraft`, refresh, stop.
- `telegramHtml.ts` (new): Markdown subset to Telegram HTML, and chunking.
- `keyedQueue.ts` (new): one turn at a time per subject, at most two across subjects (5.8).
- `commands.ts` (new): the commands and their replies (5.3).
- `brainApp.ts` (new): the bot's behaviour: access, commands, subjects, Stop, drafts, delivery and
  failure replies.
- `brainMain.ts` (new): wires the channel, the subject store, the SDK, Google Speech and
  `brainApp.ts`, and shuts them down on a signal.
- `prompts/brain-base.md` (new): the base prompt.

Shared files change additively, and the general bridge behaves as before:

- `bridge/src/claude.ts`: unchanged. The general bridge keeps its own options, and the brain calls
  the SDK from `turn.ts`.
- `bridge/src/claudeFallback.ts`: `fallbackTier`, so both profiles retry a refusal on the same
  model, region and defaults.
- `bridge/src/channels/botApiChannel.ts` and `channel.ts`: thread IDs, reply quotes, chat type,
  inline button callbacks, drafts, `setMyCommands`, the update types to request, a callback when
  polling stops, and a hook for media the brain does not read. Each acts only when the brain
  registers or sets it.
- `bridge/src/voiceMode.ts`: takes any store with `load` and `save` and any sender with
  `sendText`, so the brain's store can back `/voice`.
- `bridge/src/index.ts`: refuses an unknown profile, then routes to the brain before
  `loadConfig()`, so the brain needs none of the MTProto settings. The general flow is as it was.
- `src/config/config.ts`: exports `isValidLogLevel` for the brain's log-level check.
- `bridge/systemd/telegram-brain.service.example`, `bridge/README.md`, `README.md`, `.env.example`,
  and `.pre-commit-config.yaml` (markdownlint leaves the prompt as written).
- Tests under `test_scripts/` for each new module.

## 10. Testing

- **second-brain (pytest).** The HTTP entry lists tools with the token and returns 401 without it,
  and refuses to start with `--http` and no token file. `sql_query` rejects INSERT, UPDATE, DELETE,
  CREATE, ATTACH and writing PRAGMAs, and enforces the row cap, the cell cut and the 10 s budget. A
  replica-style database opens through the immutable path. The existing suite, ruff, mypy and the
  PII gauntlet stay green.
- **telegram-bot (vitest).** Subject keying with and without topics; a close clears only its own
  key and deletes its transcript; a resume uses the stored ID and records the returned one; the
  rebuild path runs when the transcript is missing; empty turns never replace the ID; a tool outside
  the allowlist is denied; the brain-down gate; the idle notice; HTML conversion, escaping,
  plain-text fallback and chunking; the draft throttle and refresh; Stop aborts the turn; and the
  general profile builds exactly today's options.
- **Live smoke on the VPS** (scripted, after deploy): a Greek question, an English question, a
  follow-up that depends on the previous answer, `/new` followed by a question that must not see
  the old subject, a voice note, and a `sql_query` aggregate. Record the time to first draft and to
  final answer for each.

## 11. Rollout

1. **second-brain.** Merge and let the VPS pick it up. Create the token file, install and start
   `sb-mcp.service`, and probe it with and without the token.
2. **Owner.** Create the bot in BotFather and put its token in the brain env file on the VPS.
   Optionally turn on Threaded Mode for parallel subjects.
3. **telegram-bot.** Merge, then install and start `telegram-brain.service`.
4. **Smoke.** Run the smoke script and fix what it finds before relying on the bot.
5. **Owner.** Record the Telegram copy in the private data register.

## 12. Out of scope

- Context for the general bridge bot. The same code could enable it later with one flag.
- Pointing other VPS sessions at `sb-mcp` instead of each spawning a stdio copy (about 1.6 GB
  each).
- A clearer name, or a `kinds` filter, for the semantic path of `search_emails`.
- Deleting Telegram messages on close (declined by the owner).
- Group chats and more than one user.
