# DeepSeek Harness integration — dual coding harness support

Add a server config flag so operators can choose **OpenCode** (default, current behavior) or **DeepSeek Harness (DSH)** as the coding harness under the hood. From the user's perspective — batch, interactive, and loop agent flows should look the same in the UI and API; only Settings and internal worker plumbing change.

**Status:** Phase 0 scripts committed — run `scripts/spike/docker compose up` locally to complete E2E verification

**Related:**

- [initial-build.plan.md](./initial-build.plan.md) — original OpenCode architecture
- [pr-code-review.plan.md](./pr-code-review.plan.md) — review mode (unaffected; uses OCR, not OpenCode)
- [README.md](../../README.md) — current architecture diagram
- DeepSeek Harness docs: [llms.txt](https://deepseek-harness.github.io/deepseek-harness/llms.txt)
- DeepSeek Harness repo: [github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)

---

## Executive summary

| Question | Answer |
|----------|--------|
| Is it feasible? | **Yes**, for batch / interactive / loop modes |
| Drop-in replacement? | **No** — DSH has no `opencode serve` HTTP API |
| Both in Docker? | **Yes** — install `@deepseek-ai/dsh` alongside `opencode-ai` |
| Ollama support? | **Yes** — custom OpenAI-compatible provider in `$DSH_HOME/settings.yaml` |
| Web API like OpenCode? | **No** — use `dsh --profile sdk` + stdio JSON-RPC (`@deepseek-ai/dsh-sdk-client`) |
| Review mode impact? | **None** — OCR path is separate |

**Estimated effort:** 4–6 weeks for MVP (OpenCode remains default); +2–3 weeks for strong parity.

---

## Status board

| Phase | Description | Status | Depends on |
|-------|-------------|--------|------------|
| 0 | Docker + Ollama spike | Scripts done — E2E verify locally | — |
| 1 | Config flag + `HarnessRunner` interface | Not started | 0 (recommended) |
| 2 | DSH config writer (`settings.yaml`) | Not started | 0 |
| 3 | DSH session runner (JSON-RPC client) | Not started | 0, 2 |
| 4 | DSH event mapper | Not started | 3 |
| 5 | Refactor orchestrator to use `HarnessRunner` | Not started | 1 |
| 6 | Wire batch mode | Not started | 3, 4, 5 |
| 7 | Wire interactive mode | Not started | 6 |
| 8 | Wire loop mode | Not started | 6 |
| 9 | Docker image + entrypoint | Not started | 0 |
| 10 | UI Settings + docs | Not started | 1 |
| 11 | Tests + parity hardening | Not started | 6–10 |

Phases 2–4 can run in parallel after Phase 0. Phase 5 should land before 6–8. Phase 9 can start after Phase 0.

---

## Background: how OpenCode works today

Read this section before touching any phase.

### Worker lifecycle

1. `src/domains/agents/worker/agent-worker.ts` dispatches by mode (`batch`, `interactive`, `loop`, `review`).
2. Batch / interactive / loop call into `src/integrations/opencode/session-orchestrator.ts` (`runSessionOrchestrator`, `startOpenCodeLoopSession`).
3. `src/integrations/opencode/session-runner.ts` spawns `opencode serve`, waits for `GET /path`, then exposes HTTP helpers.
4. `src/integrations/opencode/event-mapper.ts` maps OpenCode SSE events → `AgentEventType` for the UI.
5. `src/services/opencode-config.ts` writes per-agent `opencode.json` + `localagent-instructions.md`.
6. `entrypoint.sh` pre-migrates OpenCode SQLite into `{DATA_DIR}/opencode-template/` (OpenCode-only; DSH does not need this).

### Key OpenCode HTTP endpoints (reference)

| Endpoint | Purpose |
|----------|---------|
| `GET /path` | Readiness probe (health alone is insufficient during DB migration) |
| `POST /session` | Create session |
| `POST /session/{id}/prompt_async` | Send user prompt |
| `GET /event` | SSE event stream |
| `POST /permission/{id}/reply` | Auto-approve tool permissions (batch/loop) |

### Config fields used today (`AppConfig` in `src/types/index.ts`)

| Field | OpenCode usage |
|-------|----------------|
| `ollamaBaseUrl` | Provider `options.baseURL` in `opencode.json` |
| `opencodeModel` | Model id |
| `opencodeProvider` | Provider key (default `ollama`) |
| `systemPrompt` | Merged into `localagent-instructions.md` |
| `batchAutoApprovePermissions` | `permission` block in `opencode.json` |
| `loopAutoApprovePermissions` | Same |
| `interactiveAutoApprovePermissions` | Same |
| `loopVerbModels` | Per-step model override in prompt body |

---

## Background: how DeepSeek Harness differs

### Modes relevant to localagent-box

| DSH mode | Transport | Use case |
|----------|-----------|----------|
| `dsh web` | HTTP (browser UI) | **Do not use** — GUI only, not an agent API |
| `dsh --profile headless "task"` | stdout, one-shot | Batch-only; no multi-turn |
| `dsh --profile sdk` | **stdio JSON-RPC** | **Use this** — persistent sessions, multi-turn |
| Python SDK | wraps JSON-RPC subprocess | Optional; Node worker should use TS SDK |

### DSH integration pattern (target)

```
agent-worker.ts
  → runSessionOrchestrator (harness-agnostic)
    → HarnessRunner (interface)
      → OpenCodeHarnessRunner  (existing HTTP code, refactored)
      → DshHarnessRunner       (new: @deepseek-ai/dsh-sdk-client)
```

DSH subprocess: `dsh --profile sdk` with per-agent `DSH_HOME={dataDir}/agents/{agentId}/dsh-home`.

### DSH Ollama configuration

Write `$DSH_HOME/settings.yaml` before starting the subprocess:

```yaml
llm-pi-ai:
  providers:
    ollama:
      displayName: Ollama
      apiKeyEnv: OLLAMA_API_KEY
      api: openai-completions
      baseURL: http://host.docker.internal:11434/v1
      compat:
        supportsDeveloperRole: false
        thinkingFormat: deepseek
      models:
        - id: qwen3:8b
          name: Qwen3 8B
          contextWindow: 40960
          maxTokens: 8192

agent-default-model:
  provider: ollama
  model: qwen3:8b

permission:
  defaultPreset: danger-full-access
```

Set `OLLAMA_API_KEY=ollama` (or any non-empty string) in the child env — Ollama ignores it but DSH requires `apiKeyEnv` to resolve.

Settings hot-reload without restart ([providers guide](https://deepseek-harness.github.io/deepseek-harness/en/guide/providers.md)).

### Unattended / auto-approve equivalent

OpenCode: `POST /permission/{id}/reply` with `once` or `always`.

DSH: set `permission.defaultPreset: danger-full-access` (sandbox `danger-full-access` + approval `never`). See [permission presets](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/permission-presets.md).

Interactive mode with human-in-the-loop approval is **out of scope for MVP** — match current batch/loop unattended posture first.

### DSH session events (for event mapper)

DSH streams `session.event` notifications over JSON-RPC. Key event types in `SessionEventMap`:

| Event | Maps to localagent-box |
|-------|------------------------|
| `turn/start`, `turn/end` | Agent busy/idle status |
| `assistant/chunk` | `assistant.delta` (streaming text) |
| `assistant/message` | `assistant.message` + token usage |
| `tool/call` | `tool.started` |
| `tool/result` | `tool.completed` |
| `approval/asked`, `approval/decided` | `permission.requested` (if not using `never` policy) |

Full reference: [session subsystem](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/session.md).

---

## Known gaps (document, do not block MVP)

| Feature | OpenCode | DSH path |
|---------|----------|----------|
| Codegraph MCP | `ENABLE_CODEGRAPH` → `opencode.json` mcp | **Not available** — disable or log warning when harness=deepseek |
| Loop per-step agents (`plan` / `build`) | `resolveLoopStepOpenCodeAgent()` | Use single DSH composition; revisit in Phase 8 |
| Gemma reasoning workaround | `buildGemmaReasoningWorkaroundOptions()` | Use `compat` in `settings.yaml` |
| OpenCode `build` agent profile | `agent: 'build'` in prompt body | DSH uses Cordis composition — inject instructions via AGENTS.md |
| Review mode | OCR | **Unchanged** |
| Skills (Cursor-style) | OpenCode instructions | DSH has separate skills subsystem — not in MVP |
| DSH sandbox in Docker | N/A (no sandbox today) | bwrap/Landlock may fail → `danger-full-access` is correct |

DSH is in **developer preview** — pin package versions and expect breaking changes.

---

## Phase 0 — Docker + Ollama spike

**Goal:** Prove DSH can run inside the localagent-box container, call Ollama, execute tools, and complete a turn — without modifying production worker code.

**Depends on:** Nothing

**Do not:** Refactor orchestrator, add config flags, or change the UI in this phase.

### Prerequisites

- Docker (same base as `Dockerfile`: `node:trixie`)
- Ollama reachable from container (`OLLAMA_BASE_URL=http://host.docker.internal:11434`)
- A pulled model (e.g. `qwen3:8b` or whatever is in server config)

### Steps

1. Create a throwaway script at `scripts/spike/dsh-ollama-spike.mjs` (or `.ts` run via `tsx`):

   ```bash
   npm install -g @deepseek-ai/dsh @deepseek-ai/dsh-sdk-client
   ```

2. In the script:
   - Create a temp `DSH_HOME` directory
   - Write `settings.yaml` with Ollama provider (see Background section above)
   - Set env: `DSH_HOME`, `OLLAMA_API_KEY=ollama`, `OLLAMA_BASE_URL` (if needed)
   - Use `@deepseek-ai/dsh-sdk-client` `DeepSeekHarness` or `HarnessClient`:
     - `initialize` with provider `ollama`, model from env
     - `cwd` = a disposable git repo or `/tmp/spike-workspace`
     - `session_root` = `{DSH_HOME}/sessions`
   - Send prompt: `"Create a file called spike.txt with content hello"`
   - Subscribe to notifications until `turn/end` with success reason
   - Print final assistant text; verify `spike.txt` exists

3. Run inside Docker:

   ```bash
   docker build -t localagent-box-spike .
   docker run --rm -it \
     -e OLLAMA_BASE_URL=http://host.docker.internal:11434 \
     --add-host=host.docker.internal:host-gateway \
     -v "$(pwd)/scripts/spike:/spike" \
     localagent-box-spike \
     node /spike/dsh-ollama-spike.mjs
   ```

   Or exec into a running container after manual `npm install -g`.

4. Record in this plan (or a `scripts/spike/README.md`):
   - Exact `@deepseek-ai/dsh` version that worked
   - Cold-start time (first `initialize`)
   - Whether `danger-full-access` preset was required
   - Sample notification JSON for one tool call (paste truncated) — needed for Phase 4

### Acceptance criteria

- [x] Spike script committed under `scripts/spike/` with README
- [x] Pinned DSH versions documented (`0.1.1-rc.2` / `0.0.1-rc.1`)
- [x] `settings.yaml` writer + unit tests (`npm run test:unit` in `scripts/spike`)
- [x] Docker Compose stack (`ollama` + `ollama-pull` + `spike`)
- [ ] DSH subprocess starts with `dsh --profile sdk` — **verify:** `cd scripts/spike && docker compose up --build --abort-on-container-exit`
- [ ] Ollama model responds from inside container — same command
- [ ] At least one file write tool executes — same command
- [ ] `turn/end` received with `completed` reason — same command

### If spike fails

| Symptom | Try |
|---------|-----|
| `MISSING_CREDENTIAL` | Set `OLLAMA_API_KEY` env var |
| `UNKNOWN_MODEL` | Add model to `settings.yaml` models list |
| HTTP 400 on `developer` role | Add `compat.supportsDeveloperRole: false` |
| Sandbox errors in container | Set `permission.defaultPreset: danger-full-access` |
| Tool calls fail on small model | Try a larger model; document minimum viable model |
| `profile "sdk" does not exist` | In `dsh@0.1.1-rc.2` only `web`/`headless` auto-init; run `dsh plugin --profile sdk add @deepseek-ai/dsh-sdk-app@0.1.1-rc.2` (spike bootstraps this; needs pnpm/corepack) |

---

## Phase 1 — Config flag + `HarnessRunner` interface

**Goal:** Add `codingHarness` to server config and define the abstraction interface. **Do not implement DSH yet** — refactor types only.

**Depends on:** Phase 0 recommended (confirms DSH is viable) but not strictly required.

### Files to create

| File | Purpose |
|------|---------|
| `src/integrations/harness/types.ts` | `HarnessRunner`, `HarnessPrompt`, `HarnessEvent`, `HarnessSubscription` |
| `src/integrations/harness/factory.ts` | `createHarnessRunner({ harness, agentDir, workspaceDir, config })` |

### Files to modify

| File | Change |
|------|--------|
| `src/types/index.ts` | Add `codingHarness: 'opencode' \| 'deepseek'` to `AppConfig` and `PublicConfig` |
| `src/services/config-store.ts` | Default `codingHarness: 'opencode'` |
| `src/domains/config/config.repository.ts` | Validate enum on PUT |
| `src/config/env.ts` | Optional bootstrap: `CODING_HARNESS` env var |

### `HarnessRunner` interface (sketch)

```typescript
export type CodingHarness = 'opencode' | 'deepseek';

export interface HarnessPrompt {
  text: string;
  model?: { provider: string; model: string };
  agentProfile?: string; // OpenCode agent name; optional for DSH
  system?: string;
  includeFraming?: boolean;
}

export interface HarnessRunner {
  readonly harness: CodingHarness;
  start(): Promise<void>;
  createSession(opts: { cwd: string; title?: string }): Promise<{ sessionId: string }>;
  sendPrompt(sessionId: string, body: HarnessPrompt): Promise<void>;
  replyPermission?(requestId: string, reply: 'once' | 'always' | 'reject'): Promise<void>;
  abort(sessionId: string): Promise<void>;
  subscribeEvents(onEvent: (event: HarnessServerEvent) => void): HarnessSubscription;
  dispose(): Promise<void>;
}
```

`HarnessServerEvent` should be a **harness-neutral** shape (or a tagged union) that both mappers produce. Start minimal: `{ type: string; properties: Record<string, unknown> }` — same as OpenCode today — and refine in Phase 4.

### `factory.ts` behavior

```typescript
export function createHarnessRunner(opts: HarnessRunnerOptions): HarnessRunner {
  if (opts.harness === 'deepseek') {
    throw new Error('DeepSeek Harness not implemented yet'); // Phase 3 fills this in
  }
  return createOpenCodeHarnessRunner(opts); // wrap existing session-runner
}
```

### Refactor OpenCode (minimal)

- Rename or wrap `createOpenCodeSessionRunner` → `createOpenCodeHarnessRunner` implementing `HarnessRunner`
- Keep all logic in `src/integrations/opencode/` — do not move files yet
- Map `HarnessPrompt` → existing `OpenCodePromptBody` in the wrapper

### Acceptance criteria

- [ ] `GET /api/v1/config` returns `codingHarness` (default `opencode`)
- [ ] `PUT /api/v1/config` accepts `codingHarness: "deepseek"` but worker still errors clearly if selected before Phase 3
- [ ] All existing tests pass unchanged
- [ ] `createHarnessRunner({ harness: 'opencode', ... })` behaves identically to current `createOpenCodeSessionRunner`
- [ ] No behavior change when `codingHarness` is omitted or `opencode`

### Tests to add

- `src/integrations/harness/factory.test.ts` — factory returns OpenCode runner by default; deepseek throws until Phase 3

---

## Phase 2 — DSH config writer (`settings.yaml`)

**Goal:** Service that writes per-agent DSH configuration from `AppConfig` + job overrides.

**Depends on:** Phase 0 (know which `compat` fields Ollama needs)

**Can run in parallel with:** Phase 1, Phase 3

### Files to create

| File | Purpose |
|------|---------|
| `src/integrations/deepseek-harness/dsh-config.ts` | `createDshConfigService`, `writeDshSettings(runConfig, opts)` |
| `src/integrations/deepseek-harness/dsh-config.test.ts` | Unit tests for YAML output |

### Config mapping

| `AppConfig` field | `settings.yaml` path |
|-------------------|-------------------|
| `ollamaBaseUrl` | `llm-pi-ai.providers.ollama.baseURL` (ensure `/v1` suffix) |
| `opencodeModel` | `llm-pi-ai.providers.ollama.models[0].id` + `agent-default-model.model` |
| `opencodeProvider` | `agent-default-model.provider` (use provider key `ollama` when provider is `ollama`) |
| `systemPrompt` | Do **not** put in settings.yaml — inject via workspace `AGENTS.md` or DSH instructions (see Phase 3) |
| `batchAutoApprovePermissions` / `loopAutoApprovePermissions` | When true: `permission.defaultPreset: danger-full-access` |
| `interactiveAutoApprovePermissions` | When false: `permission.defaultPreset: workspace-write` (approval `ask`) — document as best-effort for MVP |

### Per-agent paths

```
{dataDir}/agents/{agentId}/dsh-home/
  settings.yaml          ← written by this service
  sessions/              ← DSH session_root (created by runner)
  .credentials.yaml      ← optional; prefer env vars
```

Set `DSH_HOME` to `dsh-home` path in the child process env.

### Loop verb models

For each verb model in `loopVerbModels`, add additional model entries if not already listed. Per-step provider/model switching happens in the session runner (`initialize` route), not in static settings — but settings must declare all model ids.

### Acceptance criteria

- [ ] `writeDshSettings()` produces valid YAML matching Phase 0 spike format
- [ ] `baseURL` normalisation: `http://host:11434` → `http://host:11434/v1`
- [ ] Unit test snapshots settings for default Ollama config
- [ ] Unit test: `danger-full-access` when `batchAutoApprovePermissions: true`
- [ ] No writes outside `{agentDir}/dsh-home/`

---

## Phase 3 — DSH session runner (JSON-RPC client)

**Goal:** Implement `DshHarnessRunner` using `@deepseek-ai/dsh-sdk-client`.

**Depends on:** Phase 0 (spike), Phase 2 (config writer)

### Files to create

| File | Purpose |
|------|---------|
| `src/integrations/deepseek-harness/session-runner.ts` | `createDshHarnessRunner()` |
| `src/integrations/deepseek-harness/session-runner.test.ts` | Mock subprocess / notification parsing tests |

### Files to modify

| File | Change |
|------|--------|
| `src/integrations/harness/factory.ts` | Return `createDshHarnessRunner` when `harness === 'deepseek'` |
| `package.json` | Add dependency `@deepseek-ai/dsh-sdk-client@<pinned>` |

### Implementation steps

1. **Install SDK** — add `@deepseek-ai/dsh-sdk-client` to `package.json` at the version proven in Phase 0. The SDK bundles/spawns `dsh --profile sdk`; verify whether system `dsh` global is still needed in Docker (likely yes — add to Dockerfile in Phase 9).

2. **Isolation env** — mirror OpenCode's `buildIsolationEnv`:

   ```typescript
   function buildDshIsolationEnv(agentDir: string): Record<string, string> {
     const dshHome = path.join(agentDir, 'dsh-home');
     return {
       DSH_HOME: dshHome,
       OLLAMA_API_KEY: 'ollama',
     };
   }
   ```

3. **`start()`** — call config service `writeDshSettings()`, mkdir `dsh-home/sessions`, construct `DeepSeekHarness` (or `HarnessClient`) with:
   - `cwd` = workspace directory
   - `session_root` = `{DSH_HOME}/sessions`
   - `provider` / `model` from run config
   - env = isolation env

4. **`createSession()`** — DSH creates sessions lazily on first `prompt`. Return a generated `sessionId` (UUID) that the client passes to subsequent calls. Store mapping if SDK assigns its own id on first prompt.

5. **`sendPrompt()`** — call `session(id).prompt(text)` or equivalent SDK method. Map `HarnessPrompt.model` to re-`initialize` if provider/model changed (loop verb models).

6. **`subscribeEvents()`** — SDK `subscribe()` or `onNotification`. Forward raw notifications to callback; Phase 4 will map them.

7. **`dispose()`** — `await harness.close()` to reap child process.

8. **`abort()`** — best-effort: send abort via SDK if available; otherwise `dispose()` + document limitation.

### Reference: OpenCode runner to mirror

Read `src/integrations/opencode/session-runner.ts` for lifecycle expectations:

- `startServer` → `waitForServerReady` → ready before `createSession`
- Debug logging via `appendLog` pattern in orchestrator (runner can accept `onDebug` callback)

### Acceptance criteria

- [ ] `createDshHarnessRunner` implements `HarnessRunner`
- [ ] Spike logic from Phase 0 works when called through `HarnessRunner` API
- [ ] Per-agent `DSH_HOME` isolation (two agents do not share sessions)
- [ ] Child process reaped on `dispose()`
- [ ] Clear error if `dsh` binary not found (message mentions Dockerfile / `npm install -g @deepseek-ai/dsh`)

### Do not

- Map events to UI types here — that's Phase 4
- Touch `session-orchestrator.ts` yet — Phase 5

---

## Phase 4 — DSH event mapper

**Goal:** Map DSH `session.event` / `session.status` notifications → same `AgentEventType` values the UI already understands.

**Depends on:** Phase 3 (real notification samples from Phase 0)

### Files to create

| File | Purpose |
|------|---------|
| `src/integrations/deepseek-harness/event-mapper.ts` | `createDshEventMapper()`, `mapDshNotification()` |
| `src/integrations/deepseek-harness/event-mapper.test.ts` | Fixture-based tests |

### Reference: OpenCode mapper

Copy patterns from `src/integrations/opencode/event-mapper.ts`:

| OpenCode event | localagent-box event |
|----------------|---------------------|
| `message.part.delta` | `assistant.delta` |
| `message.part.updated` | `assistant.delta` (snapshot diff) |
| `message.updated` (assistant) | `assistant.message` |
| `tool.part.updated` | `tool.started` / `tool.completed` |
| `permission.asked` | `permission.requested` |
| session busy/idle | `status` patch on agent record |

### DSH mapping (initial — refine with real fixtures)

| DSH `session.event` type | localagent-box event |
|--------------------------|---------------------|
| `assistant/chunk` | `assistant.delta` |
| `assistant/message` | `assistant.message` (+ extract `usage` for token counts) |
| `tool/call` | `tool.started` |
| `tool/result` | `tool.completed` |
| `turn/start` | agent status → `running` / busy |
| `turn/end` | agent status → idle; expose `reason` for orchestrator |
| `approval/asked` | `permission.requested` (should not fire with `danger-full-access`) |

### Token usage

OpenCode: `extractMessageTokenUsage()` in `session-orchestrator.ts` reads `payload.info.tokens`.

DSH: read `usage` from `assistant/message` event (`input`, `output`, cache fields if present). Add `extractDshTokenUsage()` parallel to OpenCode helper.

### Tool event normalisation

Reuse `src/lib/tool-event.ts` `normalizeToolPart` if shape is compatible; otherwise add `normalizeDshToolCall` / `normalizeDshToolResult` and converge at the same `NormalizedTool` type.

### Acceptance criteria

- [ ] Fixture tests for at least: text stream, tool call+result, turn end success, turn end error
- [ ] Token usage extracted from `assistant/message`
- [ ] Mapper exports same result shape as `MappedOpenCodeEvent` (or shared `MappedHarnessEvent` type in `harness/types.ts`)

---

## Phase 5 — Refactor orchestrator to use `HarnessRunner`

**Goal:** Make `runSessionOrchestrator` harness-agnostic. OpenCode path must still pass all existing tests.

**Depends on:** Phase 1 (interface), Phase 4 (mapper — can stub DSH mapper initially)

### Files to modify

| File | Change |
|------|--------|
| `src/integrations/opencode/session-orchestrator.ts` | Accept `HarnessRunner` or create via factory; branch event mapper by `runner.harness` |
| `src/domains/agents/worker/batch-run-flow.ts` | Pass `codingHarness` from config into orchestrator |
| `src/domains/agents/worker/interactive-session.ts` | Same |
| `src/domains/agents/worker/loop-run-flow.ts` | Same for `startOpenCodeLoopSession` (consider rename to `startLoopSession`) |
| `src/domains/agents/worker/worker-context.ts` | Include `codingHarness` in resolved run config |

### Refactor steps

1. Add `createHarnessEventMapper(harness: CodingHarness)` in `src/integrations/harness/event-mapper-factory.ts`.

2. In `runSessionOrchestrator`:
   - Replace `createOpenCodeSessionRunner` → `createHarnessRunner({ harness: runConfig.codingHarness, ... })`
   - Replace `createOpenCodeEventMapper` → `createHarnessEventMapper(runner.harness)`
   - Rename log lines: `OpenCode ...` → `Harness(${harness}) ...` or keep OpenCode-specific logs behind `if (harness === 'opencode')`

3. Config writing:
   - If `opencode`: existing `createOpenCodeConfigService` path
   - If `deepseek`: `createDshConfigService` path (Phase 2)
   - Skip `opencode.json` writes when harness is `deepseek`

4. Permission auto-approve:
   - OpenCode: HTTP `replyPermission`
   - DSH: no-op in orchestrator (policy set in settings); guard `replyPermission` with optional chaining

5. Codegraph:
   - If `enableCodegraph && harness === 'deepseek'`: log warning, skip MCP injection

### Acceptance criteria

- [ ] All existing `src/integrations/opencode/*.test.ts` tests pass
- [ ] All existing `batch-run-flow.test.ts`, `worker-context.test.ts` pass
- [ ] Default config (`codingHarness: opencode`) — zero behavior change
- [ ] `codingHarness: deepseek` reaches DSH runner (integration test or manual smoke)

### Do not

- Change review worker (`review-run-flow.ts`)
- Change git commit/push logic

---

## Phase 6 — Wire batch mode (DSH end-to-end)

**Goal:** Batch agents complete successfully with `codingHarness: deepseek`.

**Depends on:** Phases 3, 4, 5

### What batch mode needs

Read `src/domains/agents/worker/batch-run-flow.ts`:

1. Single prompt → wait for idle → check `filesChanged` → commit/push
2. `disableQuestionTool` equivalent: DSH should not block on user questions — ensure composition does not mount question tool, or policy denies it
3. Zero-file guard: `resolveBatchFailureMessage` when no edits

### Steps

1. Run batch agent manually with `codingHarness: deepseek` against a test repo.
2. Verify orchestrator detects turn complete (DSH `turn/end` reason).
3. Verify `filesChanged > 0` detection still works (git-based, harness-independent).
4. Fix mapper gaps found in real run (streaming text in UI, tool cards).

### Acceptance criteria

- [ ] `POST /api/v1/agents` with `mode: batch` completes with `codingHarness: deepseek`
- [ ] UI shows assistant text and tool events during run
- [ ] Agent record: `opencodeSuccess: true` (consider renaming to `harnessSuccess` in follow-up — optional, not MVP)
- [ ] Commit and push succeed when model edits files
- [ ] Batch fails when model makes no file changes (existing guard)

---

## Phase 7 — Wire interactive mode

**Goal:** Multi-turn interactive sessions work with DSH.

**Depends on:** Phase 6

### What interactive mode needs

Read `src/domains/agents/worker/interactive-session.ts`:

- Inbox polling → subsequent `sendPrompt` on **same session id**
- Finish command → orchestrator returns `outcome: 'finish'`
- Status transitions: `awaiting_input` between turns

### DSH-specific notes

- Reuse same DSH session across prompts (do not call `dispose()` between turns)
- `interactiveAutoApprovePermissions: false` — MVP may still use `danger-full-access`; document that interactive permission UI is OpenCode-only until a DSH approval answerer is built

### Acceptance criteria

- [ ] Create interactive agent with `codingHarness: deepseek`
- [ ] Send follow-up message via inbox API
- [ ] Finish ends session and triggers commit/push
- [ ] `awaiting_input` status appears between turns in UI

---

## Phase 8 — Wire loop mode

**Goal:** Loop harness (orient/act/reflect cycles) works with DSH.

**Depends on:** Phase 6

### What loop mode needs

Read `src/domains/agents/worker/loop-run-flow.ts` and `src/integrations/opencode/session-orchestrator.ts` (`startOpenCodeLoopSession`):

- Session rotation per iteration (`rotateSession`)
- Per-step model via `resolveLoopStepModel` → pass model in `HarnessPrompt`
- Per-step agent profile via `resolveLoopStepOpenCodeAgent` → **DSH MVP: ignore or use single profile**
- `runTurn({ agent, model, includeFraming })` for each loop step

### DSH-specific approach

**Option A (MVP):** One DSH session per loop step (rotate = dispose + new session). Simpler; matches OpenCode rotation semantics.

**Option B:** One long DSH session across iteration. Fewer cold starts; harder to switch models per verb.

**Recommend Option A** for parity with OpenCode session rotation.

### Loop verb models

On each step, if `resolveLoopStepModel` returns a model, call SDK `initialize` with new provider/model before `sendPrompt`. Verify in spike before implementing.

### Per-step agents (`plan` / `build`)

OpenCode passes `agent: 'plan' | 'build'` in prompt body. DSH has no equivalent agent name — **MVP:** rely on step prompt text only (loop.json prompts already differ by verb). Document as known gap.

### Acceptance criteria

- [ ] Loop agent runs at least 2 iterations with `codingHarness: deepseek`
- [ ] `loop-plan.md` / handoff state updates (host-side — harness-independent)
- [ ] Per-verb model switching works OR documented as unsupported with fallback to global model
- [ ] `LOOP_COMPLETE` detection still works

---

## Phase 9 — Docker image + entrypoint

**Goal:** Production image includes DSH; OpenCode path unchanged.

**Depends on:** Phase 0 (pinned version)

### Files to modify

| File | Change |
|------|--------|
| `Dockerfile` | `RUN npm install -g @deepseek-ai/dsh@<pinned>` |
| `docs/docker-hosting.md` | Note both harnesses installed; `CODING_HARNESS` env bootstrap |
| `entrypoint.sh` | No change for DSH (OpenCode prewarm stays) |

### Dockerfile addition (example)

```dockerfile
# After opencode-ai install line:
RUN npm install -g @deepseek-ai/dsh@0.1.0-rc.6
RUN dsh --version
```

Pin exact version from Phase 0 spike.

### Image size note

DSH is significantly larger than OpenCode. Consider:

- Document image size increase in `docker-hosting.md`
- Future: `slim` vs `full` image tags (out of scope for MVP)

### Acceptance criteria

- [ ] `docker build` succeeds
- [ ] `docker run ... dsh --version` works as `node` user
- [ ] `docker run ... opencode --version` still works
- [ ] Batch agent with `codingHarness: deepseek` works in built image

---

## Phase 10 — UI Settings + documentation

**Goal:** Operator can select harness in Settings; docs explain tradeoffs.

**Depends on:** Phase 1

**Can run in parallel with:** Phases 6–9

### Files to modify

| File | Change |
|------|--------|
| `client/src/pages/SettingsPage.tsx` | Dropdown: Coding harness → OpenCode / DeepSeek Harness |
| `client/src/api/types.ts` | `codingHarness` on config type |
| `README.md` | Mention dual harness support |
| `docs/docker-hosting.md` | `CODING_HARNESS` env var |
| `docs/README.md` | Link this plan |

### UI copy (suggested)

- **OpenCode** (default) — mature integration, codegraph MCP, full loop agent profiles
- **DeepSeek Harness** (experimental) — developer preview; no codegraph; local models via Ollama

Show warning badge when DeepSeek selected.

### Acceptance criteria

- [ ] Settings save/load `codingHarness`
- [ ] README architecture section mentions config flag
- [ ] `docs/README.md` links to this plan

---

## Phase 11 — Tests + parity hardening

**Goal:** Regression coverage for both harnesses; document remaining gaps.

**Depends on:** Phases 6–10

### Tests to add

| Area | File |
|------|------|
| DSH config writer | `dsh-config.test.ts` |
| DSH event mapper | `event-mapper.test.ts` |
| Harness factory | `factory.test.ts` |
| Orchestrator harness branch | extend `session-orchestrator` tests if any |
| Config API | `config.repository` validation for `codingHarness` |

### Optional integration test

- Mark `@integration` or skip in CI if no Ollama
- Script: start worker with `codingHarness: deepseek`, mock or real Ollama

### Hardening checklist

- [ ] Pin `@deepseek-ai/dsh` and `@deepseek-ai/dsh-sdk-client` versions in Dockerfile + package.json
- [ ] Log harness name on agent start
- [ ] Health check: optional `dsh --version` in `/health` when deepseek is selected
- [ ] Rename `opencodeSuccess` → `harnessSuccess` (optional follow-up issue)
- [ ] Document minimum Ollama models for DSH tool calling

### Acceptance criteria

- [ ] `npm test` passes
- [ ] This plan's status board updated with completed phases
- [ ] Known gaps section reviewed and still accurate

---

## File layout (target)

```
src/integrations/
  harness/
    types.ts
    factory.ts
    event-mapper-factory.ts
    factory.test.ts
  opencode/                    # existing — wrapped by factory
    session-runner.ts
    session-orchestrator.ts
    event-mapper.ts
    runner.ts
  deepseek-harness/            # new
    dsh-config.ts
    dsh-config.test.ts
    session-runner.ts
    session-runner.test.ts
    event-mapper.ts
    event-mapper.test.ts
scripts/spike/
  dsh-ollama-spike.mjs
  README.md
```

---

## Risks register

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| DSH breaking API changes | High | High | Pin versions; abstraction layer |
| Ollama tool-calling weaker on DSH | Medium | Medium | Keep OpenCode default; document models |
| JSON-RPC harder to debug than HTTP | Medium | Low | Log stderr from DSH child; spike fixtures |
| Image size bloat | High | Low | Document; optional slim image later |
| Loop verb model switching broken | Medium | Medium | Spike in Phase 0; fallback to global model |
| Codegraph unavailable on DSH | Certain | Low | Disable with warning |
| Interactive permission UI missing | Medium | Medium | Document; OpenCode-only for approval UX |

---

## Out of scope (MVP)

- Driving `dsh web` HTTP API from localagent-box
- DSH skills integration
- DSH subagent parity with OpenCode task tool
- Interactive permission approval UI for DSH
- Replacing OCR / review mode
- Renaming all `opencode*` config fields (keep names for backward compatibility; they apply to both harnesses as "model settings")

---

## Quick reference: phase pick-up checklist

When starting a phase, the implementing agent should:

1. Read **Background** sections above
2. Read **Depends on** — complete prerequisite phases first
3. Open every file listed in **Files to create/modify**
4. Run `npm test` before and after
5. Update the **Status board** at the top of this document when done
6. Do not expand scope into adjacent phases
