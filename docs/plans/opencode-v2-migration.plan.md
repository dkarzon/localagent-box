# OpenCode v2 migration

Plan for moving localagent-box from **OpenCode 1.19.4** (`opencode-ai`) to **OpenCode 2.x** (`@opencode/cli`, currently 2.2.7). This document covers research findings, the impact on our code, and a phased plan. **No code changes are included here.**

**Related:** `Dockerfile`, `entrypoint.sh`, `src/integrations/opencode/*`, `src/services/opencode-config.ts`, `src/domains/agents/worker/*-run-flow.ts`, `client/src/lib/{transcript,format-tool,resolve-tool-call-id}.ts`, `docs/opencodeapi.json` (v1 OpenAPI snapshot)

**Sources:** https://opencode.ai/docs/migrate-v1/, https://opencode.ai/docs/api/, https://opencode.ai/docs/permissions/, https://opencode.ai/docs/providers/, https://opencode.ai/v2/docs/cli/commands/, https://github.com/anomalyco/opencode/releases, `npm view @opencode/cli` / `npm view opencode-ai` (checked 2026-11-11)

---

## TL;DR

- v2 is a **new package** (`@opencode/cli`). `opencode-ai` stays on 1.x (latest 1.19.5), so a version bump on the existing line won't get us v2.
- The **HTTP server API is fully rewritten.** Routes move under `/api/...`, the event envelope changes from `{type, properties}` to `{id, created, type, location, data, durable?}`, and the event names are new. Questions become "forms". Our whole integration layer is built on the v1 API.
- **Config:** the v1 shape is still accepted. The new native shape is optional, except for permissions, which we should rewrite to the new ordered array to be safe.
- **We don't need to migrate any data.** Every agent runs `opencode serve` against its own throwaway XDG dirs, so v1 sessions never need to survive.
- **Recommended approach:**
  - Add a translation layer at the `session-runner` boundary that turns v2 routes and events into the internal shapes we already use.
  - Leave `event-mapper`, the orchestrator and the UI almost untouched. Transcripts already stored from v1 runs keep rendering.
  - Do a hard cutover with no dual v1/v2 support. To roll back, use the previous Docker image tag.
- **Size:** about 3–5 days, mostly in the runner and event translation, plus a 0.5-day spike to resolve the unknowns below.

---

## How we use OpenCode today

| Area | v1 usage | Where |
|---|---|---|
| Install | `npm install -g opencode-ai@v1.19.4` | `Dockerfile` (README still says 1.18.18, which is already stale) |
| Server lifecycle | `opencode serve --hostname 127.0.0.1 --port N` | `session-runner.ts` |
| Readiness | `GET /path` (DB migration gate), `GET /global/health` | `session-runner.ts`, `entrypoint.sh` |
| Sessions | `POST /session`, `POST /session/{id}/prompt_async`, `POST /session/{id}/abort`, `GET /session/status` (turn completion polling) | `session-runner.ts`, `session-orchestrator.ts` |
| Permissions | `POST /permission/{id}/reply` (`once`/`always`/`reject`) on `permission.asked`/`permission.updated` | `session-orchestrator.ts` |
| Events (SSE `/event`) | `message.part.delta`, `message.part.updated` (text / reasoning / tool parts), `message.updated`, `session.status`, `session.idle`, `session.error`, `session.created/updated`, `permission.*`, `server.connected` | `event-mapper.ts`, `session-orchestrator.ts` |
| Config | Generated `opencode.json`: `provider` (openai-compatible → Ollama/cloud), `model`, `instructions`, `permission` wildcard map, legacy `tools.question:false` + `permission.question:'deny'`, `mcp.codegraph` | `opencode-config.ts` |
| Isolation | Per-agent `XDG_DATA_HOME/STATE/CONFIG` + `OPENCODE_CONFIG_DIR`; data dir seeded from a pre-migrated DB template | `session-runner.ts`, `entrypoint.sh` |
| Repo config | `.opencode/opencode.json` with `plugin: []`, `skills.paths` | repo root |

The OCR code-review integration (`@alibaba-group/open-code-review`) doesn't use the OpenCode binary, so it's **out of scope**.

---

## v2 changes that affect us

### 1. Packaging and binary
- `npm i -g @opencode/cli@2.2.7` installs bins `opencode` and `opencode2`, and the docs say to use `opencode`. `OPENCODE_BIN` stays valid.
- There's also an official image, `ghcr.io/anomalyco/opencode:<ver>`, but we keep our own Node base image.
- v1 and v2 can't be installed side by side under the same bin name. Local dev machines need to uninstall `opencode-ai` first.

### 2. Server API (breaking)
| v1 | v2 |
|---|---|
| `POST /session` | `POST /api/session` |
| `POST /session/{id}/prompt_async` | `POST /api/session/{id}/prompt` (409 on conflict). **Unknown** whether it waits for the reply or returns immediately |
| `POST /session/{id}/abort` | `POST /api/session/{id}/interrupt?resume=` |
| `GET /session/status` | **Unknown.** Status probably comes through `session.status` events or `GET /api/session/{id}`; needs the spike |
| `POST /permission/{id}/reply` | `POST /api/session/{id}/permission/{requestID}/reply` (reply values unchanged: `once`/`always`/`reject`) |
| `/question/*`, `question.asked` | `/api/session/{id}/form/*`, `form.created/replied/cancelled` |
| `GET /event` (SSE) | `GET /api/event?types=` (volatile: a slow consumer fails the stream, and events are lost on disconnect). Durable per-session log: `GET /api/experimental/session/{id}/log?after=&follow=` |
| `GET /path`, `/global/health` | **Unknown.** A `ServerInfo` schema exists (`version, pid, hostname, urls, paths, capabilities`); the route is likely `/api/info` |
| Directory implicit (cwd) | Most routes accept a `location` query object |

### 3. Events (breaking)
- **Envelope:** `{ id, created, metadata, type, location, data, durable? }` replaces `{ type, properties }`.
- **No `message.part.updated` or `message.updated`.** Streaming is now split into separate events:

| v2 event | Maps to our internal event |
|---|---|
| `session.text.started/delta/ended` | `assistant.delta` (field `text`) and the final text on end |
| `session.reasoning.started/delta/ended` | `assistant.delta` (field `reasoning`) |
| `session.tool.input.*`, `session.tool.called` | `tool.start` |
| `session.tool.progress` | tool update (optional) |
| `session.tool.success/failed` | `tool.end` |
| `session.step.started/ended/failed` | step boundary; usage/tokens likely on `ended` (currently from `message.updated`) |
| `session.execution.started/succeeded/failed/interrupted` | turn start and turn completion. **Probably a cleaner completion signal than polling `/session/status`** |
| `session.status`, `session.idle` | unchanged names, payload under `data` |
| `session.message.content.updated` | possibly a full-snapshot fallback |
| `permission.asked/replied`, `form.created` | permission auto-reply; form auto-cancel in unattended modes |

The published reference doesn't expand the inner `data` schemas, so the spike has to capture real payloads.

### 4. Config
- **Permissions** move to an ordered `permissions: [{action, resource, effect}]` list, where the last match wins and no match means `ask`.
  - Action renames: `bash`→`shell`, `task`→`subagent`, `write`/`patch`→`edit`.
  - Auto-approve becomes `[{action:'*',resource:'*',effect:'allow'}, {action:'question',resource:'*',effect:'deny'}]`.
  - This replaces our `tools` + `permission` workaround.
- **`external_directory` now defaults to allow** (v1 asked).
  - When auto-approve is off, add `{action:'external_directory',resource:'*',effect:'ask'}` to keep the v1 behaviour.
  - Agents run in isolated clones, so this matters for containment.
- **Provider renames:** `provider`→`providers`, `npm`→`package` (`@opencode/ai/providers/openai-compatible`), `options.baseURL`→`settings.baseURL`.
  - The v1 shape is still accepted. We should still move to the native shape so we don't depend on a compatibility path.
  - **Verify** that the per-model `limit` and `options.extraBody` (Gemma reasoning workaround) still exist in v2.
- **Other renames:** `mcp.<name>`→`mcp.servers.<name>` (`enabled` becomes `disabled`), `plugin`→`plugins`. `model` and `instructions` are unchanged.
- **CLAUDE.md is no longer read.** Only AGENTS.md is.
  - Target repos that only have CLAUDE.md silently lose their instructions.
  - Mitigation: add `CLAUDE.md` to `instructions` when it exists and AGENTS.md doesn't.
- **Todos are off by default** (`experimental.todo`). Decide whether to enable them, because the UI renders the todo tool.
- **Plugins:** v1 plugins don't run in v2. We have none (`plugin: []`). The `skills.paths` key in `.opencode/opencode.json` isn't confirmed for v2.
- **Storage:** sessions live in a single `opencode.db`; `OPENCODE_DB` overrides the path.
- **Server auth:** `OPENCODE_SERVER_USERNAME` is removed and `OPENCODE_PASSWORD` is new. We bind to 127.0.0.1 without auth today, so nothing changes for us.

---

## Spike results (2026-11-11, `@opencode/cli` 2.2.7 on Windows, isolated XDG dirs)

Spec saved as `docs/opencodeapi.v2.json` (from `GET /openapi.json`). A captured event stream is in `scripts/fixtures/opencode-v2-events-retry-interrupt.sse`. No Ollama was running, so the capture covers retry and interrupt, not a successful turn.

| # | Question | Answer |
|---|---|---|
| — | **Auth** | **The server needs a password by default.** Without `OPENCODE_PASSWORD` it generates a random one and prints it to stdout. All `/api/*` routes and `/openapi.json` return 401 without HTTP Basic (`opencode:<password>`). **The runner must generate a per-agent password, pass it in the env, and send Basic auth on every request.** |
| 1 | OpenAPI | `GET /openapi.json` (needs auth). `/doc` is the web UI. |
| 2 | Prompt | `POST /api/session/{id}/prompt` **returns immediately** (~10 ms) with the queued user message (`Session.Inbox.User`). Body: `{ id?, text, files?, agents?, skills?, metadata?, delivery?: 'steer'\|'queue', resume? }`. **No `agent`, `model` or `system` fields.** Set the model and agent when creating the session (`POST /api/session { title, location:{directory}, model:{id, providerID}, agent, permissions? }`) or switch them later with `POST /api/session/{id}/model` and `/agent`. A per-prompt `system` has no equivalent; use config `instructions` or `experimental.session.instructions.entry.put`. |
| 3 | Events | SSE at `GET /api/event[?types=…]`. Frames are `data: {json}` lines separated by blank lines, plus `: heartbeat` comments, so `parseSseDataLine` still works. The envelope is `{ id, created, metadata?, type, location?, data, durable?: { aggregateID, seq, version } }`, and the first event is `server.connected`. Every payload type is defined in the spec. The key ones are listed after this table. |
| 4 | Readiness | **The DB bootstrap takes 7 ms (59 migrations), so the template pre-warm in `entrypoint.sh` and `seedOpenCodeDataFromTemplate` can be deleted.** `GET /path` and `/global/health` now return the web UI's HTML with a 200, **so the current readiness check would always pass.** Use authenticated `GET /api/info` (`{version, pid, ...}`). |
| 5 | Turn status | **No `session.status` or `session.idle` events fired** during the turn. Turns are bracketed by `session.execution.started`, followed by one of `.succeeded`, `.failed`, or `.interrupted{reason}`. The polling fallback is `GET /api/session/active`, which returns `{ <sid>: {type:'running'} }`; a missing entry means idle. `GET /api/session/{id}` also shows `time.busy`. |
| 6 | Model config | The v1 `provider` block loads and is converted in memory to native: `package: 'aisdk:@ai-sdk/openai-compatible'` (resolved to `@opencode/ai/providers/openai-compatible`), `options.baseURL` → `settings.baseURL`, model `options.reasoningEffort` → `settings`, `options.extraBody` → model `body`. `name` and `limit.context/output` are kept. **The Gemma workaround and context limits survive.** |
| 7 | Location | Events are global and carry `location.directory`, so filter by `data.sessionID`. Sessions are bound to a directory at create time via `location.directory`. |
| — | Config | `GET /api/config` shows that both `$XDG_CONFIG_HOME/opencode` and `OPENCODE_CONFIG_DIR` are read. Generated `permissions` and `mcp.servers` are accepted unchanged, with no warnings. The MCP server launched (codegraph failed only because it isn't installed on this PC). |
| — | **Instructions** | **A relative `instructions: ["localagent-instructions.md"]` is NOT loaded in v2** (no `core/instructions` entry). An absolute path is loaded. Fixed: `writeOpenCodeConfig` now writes the absolute path. AGENTS.md in the session directory loads as `core/instructions`. |
| — | Agents | `build, general, explore, compaction, title, summary, plan` |
| — | Provider down | Unreachable provider leads to `session.retry.scheduled{attempt, at, error}` with backoff (2 s, 4 s, 7 s …). The execution stays `running`; our agent timeout still applies. Consider surfacing retries in the UI log. |

Key v2 event payloads (`data`):
- `session.text.delta {sessionID, assistantMessageID, ordinal, delta}`; `session.text.ended {…, ordinal, text}`. `session.reasoning.*` has the same shape.
- `session.tool.input.started {sessionID, assistantMessageID, id, name}`. **This is the only event that carries the tool name**, so the adapter must remember `id → name`.
- `session.tool.called {…, id, input, executed}`; `session.tool.success {…, id, content[], metadata?}`; `session.tool.failed {…, id, error{type, message}}`; `session.tool.progress {…, id, metadata}`.
- `session.step.started {…, agent, model}`; `session.step.ended {…, finish, cost, tokens{input, output, reasoning, cache{read, write}}}`; `session.step.failed {…, error}`.
- `session.execution.succeeded|failed{error}|interrupted{reason}`.
- `permission.asked {id, sessionID, action, resources[], source?}`. Reply: `POST /api/session/{sid}/permission/{id}/reply { decision: 'once'|'always'|'reject', message? }` → 204.
- `form.created {form:{id, sessionID, title, fields}}`. Cancel: `DELETE /api/session/{sid}/form/{id}` → 204.
- `session.message.content.updated {sessionID, messageID, content[]}`: full snapshot, which can serve as the fallback for missed deltas.

### Original unknowns (kept for reference)

Run `@opencode/cli@2.2.7` in a scratch container with an isolated XDG dir and an Ollama endpoint, then record:

1. **`GET /doc` (or v2 equivalent) OpenAPI JSON.** Save it as `docs/opencodeapi.v2.json`, replacing guesswork with the real schema. This answers most of the items below.
2. Does `POST /api/session/{id}/prompt` wait for the reply or return immediately? What is the request body shape (`parts`, `agent`, `model`, `system`, `messageID`)?
3. A real NDJSON capture of `/api/event` for one turn: text, reasoning, a tool call, a permission ask, a forced question/form, an error, and an interrupt. Check this into `scripts/` as fixtures for tests.
4. Readiness: which route answers only after the DB is ready? Does first start still trigger the multi-minute migration that `entrypoint.sh` pre-warms around? If not, **delete the template pre-warm entirely**, which is a nice simplification.
5. The status endpoint that replaces `GET /session/status`, or confirmation that `session.execution.*` events are enough.
6. Does the v2 model config accept `limit.context/output` and `options.extraBody`?
7. Does `/api/event` require the `location` param to scope events to our session directory?

---

## Implementation plan

### Phase 0: Spike (above)
Output: a v2 OpenAPI snapshot, event fixtures, and answers to the unknowns, appended to this doc.

### Phase 1: Install and lifecycle
- `Dockerfile`: replace `opencode-ai@v1.19.4` with `@opencode/cli@2.2.7`, pinned. Keep the `~/.local/share/opencode` dirs.
- `entrypoint.sh`: update the readiness probe route, or remove the pre-warm if the spike shows it isn't needed.
- `session-runner.ts`:
  - Update `waitForServerReady` (route and phases).
  - Update `seedOpenCodeDataFromTemplate`: keep it, set `OPENCODE_DB`, or delete it.
- `runner.ts`: update the Windows binary candidate paths (`node_modules/@opencode/cli/bin/opencode.exe`).
- README / `docs/docker-hosting.md`: update the install line and fix the stale 1.18.18 reference.

### Phase 2: API client (`session-runner.ts`)
- Re-point `createSession`, `sendPromptAsync`, `abort`→`interrupt` and `replyPermission` to the `/api/...` routes. If `/prompt` waits for the reply, fire it without awaiting the response body and rely on events.
- Add `cancelForm(sessionId, formId)` for unattended modes, as a backstop to the `question: deny` permission.
- Update `OpenCodeSession`, `OpenCodePromptBody` and the other types from the v2 OpenAPI snapshot. Replace the "OpenCode 1.0.218" comment.
- Rewrite `subscribeEvents`:
  - Connect to `/api/event` and parse the new envelope.
  - The stream is volatile, so on reconnect, catch up via `/api/experimental/session/{id}/log?after=<lastId>`. Alternatively, use that log endpoint as the primary stream if it's stable enough; it's still under `experimental`, so weigh that.

### Phase 3: Event translation (core of the work)
- Add `src/integrations/opencode/v2-event-adapter.ts`. It converts v2 events into the **existing** internal shapes that `event-mapper` already consumes: text and reasoning deltas plus a full snapshot on `*.ended`, tool parts with the `status` values `normalizeToolPart` expects, and status, idle and error events.
- Rationale: `event-mapper.ts` (382 lines), `session-orchestrator.ts` (1116 lines) and the client transcript code stay stable, and stored v1 transcripts in `data/` still render.
- Turn completion: switch from polling `GET /session/status` (busy→idle) to `session.execution.succeeded/failed/interrupted` if the spike confirms they're reliable. Keep a status poll as a fallback if not. This touches both orchestrator loops (around lines 634 and 1047).
- Token usage: source it from `session.step.ended` instead of `message.updated`.
- Update `scripts/verify-event-mapper.ts` and add adapter unit tests driven by the Phase 0 fixtures.

### Phase 4: Config generation (`opencode-config.ts`)
- Emit `permissions: [...]` arrays and drop `tools.question` and the old `permission` map. Add the `external_directory: ask` rule when auto-approve is off.
- Emit `providers.<id>` with `package` and `settings.baseURL`.
- Emit `mcp.servers.codegraph` with `disabled:false` and the `timeout` kept.
- Emit the CLAUDE.md fallback into `instructions`.
- Update `opencode-config.test.ts` (49 references) and `config/opencode.default.json`.
- Update repo `.opencode/opencode.json`: `plugin`→`plugins`, and confirm `skills`.

### Phase 5: UI and docs
- Check the client tool formatting (`format-tool.ts`, `resolve-tool-call-id.ts`) against any new tool names, such as `shell` instead of `bash`, and tool-ID fields. Add aliases so both v1 and v2 names render.
- Settings page: no structural change expected.
- Supersede the v1 API details in `docs/plans/question-tool-handling.plan.md` and `docs/one-shot-batch-options.md`, or add a note.

### Phase 6: Verification
- `npm test` and `npm run build`; client build.
- Docker build, then an end-to-end run of each mode against local Ollama:
  - **batch:** prompt → edits → commit.
  - **interactive:** stream, permission prompt reply, finish.
  - **loop:** multi-step with model switching; the question tool is denied and nothing hangs.
  - **review / autofix flows.**
  - **codegraph MCP:** loads within the timeout.
- Open an old v1-era agent session in the UI and confirm the transcript still renders.
- Measure cold-start time with and without the DB template.

---

## Progress (branch `opencode-v2`)

**Done (uncommitted):**
- [x] `Dockerfile` pins `@opencode/cli@2.2.7`. The README install line is updated, with a note to uninstall v1 first.
- [x] Windows binary hint path is now `node_modules/@opencode/cli/bin/opencode.exe` (`runner.ts`).
- [x] Per-agent config dir moved to `$XDG_CONFIG_HOME/opencode` (`getAgentOpenCodeConfigDir`). The v2 docs don't mention `OPENCODE_CONFIG_DIR`, so OpenCode now finds the file through its default location as well.
- [x] Generated config uses the native v2 ordered `permissions` array (`buildPermissionRules`):
  - Auto-approve: `* allow`, followed by `question deny`.
  - No auto-approve: `external_directory ask`, keeping the v1 default.
  - The legacy `tools` and `permission` keys are dropped.
- [x] Codegraph MCP is now `mcp.servers.codegraph`, with `disabled:false` and `timeout.catalog: 15000`.
- [x] `.opencode/opencode.json`: `plugin` renamed to `plugins`.
- [x] Tests: `opencode-config.test.ts` is updated and passing. The full suite shows 29 failures, the same 29 as on `main` on Windows (bootstrap path separators, review-run-flow).

- [x] Spike done (see Spike results). The v2 OpenAPI snapshot and event fixture are checked in, uncommitted.
- [x] `instructions` now uses an absolute path; v2 ignored the relative one. Covered by a test.

**Deliberately deferred:**
- `provider` block stays in v1 form. The spike confirmed v2 loads it and keeps `limit`, `reasoningEffort` and `extraBody`, now `body`. Moving to native is optional; the mapping is in Spike results row 6.
- CLAUDE.md `instructions` fallback. Absolute paths work, so this needs only the workspace path passed into `buildOpenCodeConfig`.

**Next (Phase 1 remainder, then Phases 2–3), now unblocked:**
- Per-agent `OPENCODE_PASSWORD` plus Basic auth on every request in `session-runner.ts`.
- Readiness via `GET /api/info`. Delete the template pre-warm (`entrypoint.sh`, `seedOpenCodeDataFromTemplate`).
- Model and agent set at session create, `/model` on model switch (loop verb models). `system` moves to instruction entries or config.
- `v2-event-adapter.ts` driven by the fixture. Turn completion via `session.execution.*`, with a fallback poll of `/api/session/active`.
- `config/opencode-tool-instructions.md` still refers to the `bash` tool. v2 renames it to `shell`, so update it after the spike confirms tool names and whether `description` is still required.
- `skills.paths` in `.opencode/opencode.json` isn't confirmed for v2.
- Phases 0, 2 and 3 (spike, API client, event adapter) are blocked on running v2 locally. Installing it here was refused by the permission policy, so it needs user approval or a manual run.

---

## Risks

| Risk | Mitigation |
|---|---|
| `/api/event` is volatile; dropped events can stall turn detection | Catch up from the durable session log on reconnect, and keep a status-poll fallback |
| Experimental durable-log route changes in 2.3+ | Pin the exact version and re-run the fixtures on every bump |
| Event `data` shapes differ from what we infer | Phase 0 fixtures and an adapter covered by tests; no code before the spike |
| `external_directory` silently allowed | Explicit rule in generated config, plus a test |
| Repos relying on CLAUDE.md lose instructions | `instructions` fallback |
| OpenAI-compatible provider changes break Ollama cloud or reasoning options | Spike item 6, and an end-to-end run with Gemma and a cloud model |
| Local Windows devs still have v1 installed | README note to uninstall `opencode-ai`; `OPENCODE_BIN` override still works |

## Rollout
- Single branch/PR with a hard cutover; no runtime v1/v2 switch. That would double the surface area for little gain, since there's no persistent OpenCode state.
- Rollback means redeploying the previous image tag. Agent data in `/data` is compatible because internal event shapes don't change.
