# Loop mode — token efficiency improvements

Reduce input/output token spend per loop run against small local models (llama3.2-class, modest context windows). Two themes: **shrink what each turn has to read** (fewer steps, less repeated framing, bounded handoffs) and **move deterministic work from the model to the host** (repo map, diffstat, check command, plan-file verification).

**Status:** Plan (not implemented)

**Related:** [loop-verb-models.plan.md](./loop-verb-models.plan.md), `src/domains/agents/worker/loop-run-flow.ts`, `src/domains/agents/worker/loop-config.ts`, `src/integrations/opencode/runner.ts`, `src/integrations/opencode/session-orchestrator.ts`, `config/loop.default.json`

---

## Background / cost model

- All steps in one iteration share an OpenCode session; each subsequent step replays the whole conversation (OBSERVE's tool outputs are re-sent as input to PLAN, ACT, REFLECT). Input cost grows roughly quadratically with steps-per-iteration.
- Sessions rotate per iteration (`rotateSession()`); the only carried context is the raw REFLECT text injected into the next iteration's first step — unbounded, unstructured prose.
- `buildOpenCodePrompt` re-appends system prompt + loop context to **every** step's user message.
- OBSERVE's default prompt invites full codebase re-exploration every iteration.
- `max_iterations` exhaustion throws → run fails, discarding work unless `pushOnFailure`.

---

## 1. Steps

### 1.1 Merge OBSERVE + PLAN into one ORIENT step (biggest win)

Both are read-only reasoning over the same context; merging cuts one full history replay per iteration. New default iteration shape: **ORIENT → ACT → REFLECT** (3 steps).

- `config/loop.default.json`: replace OBSERVE + PLAN entries with one step, prompt: *"Inspect only files relevant to the next unfinished item in `.localagent-box/loop-plan.md`, then state the smallest next change. If the goal is already fully achieved, output `{{completionMarker}}: true` and nothing else."*
- **Decision (implemented):** OBSERVE and PLAN were fully replaced by a new `ORIENT` verb rather than aliasing one of them. `LoopVerb` is now `'INITIAL_PLAN' | 'ORIENT' | 'ACT' | 'REFLECT'` across server (`types/index.ts`) and client (`api/types.ts`), including `loopVerbModels` keys, defaults, model-resolution (`loop-model.ts`), Settings UI presets/labels, and the completion-signal early-exit check. To avoid breaking data written against the old names, legacy `OBSERVE`/`PLAN` are normalized to `ORIENT` at every input boundary: repo `loop.json` step verbs (`validateLoopConfig`), persisted `config.json` on load (`config-store` via `normalizeLoopVerbModels`), and the config/create-agent APIs (`sanitizeLoopVerbModels`).

### 1.2 Early exit on the first step

`loop-run-flow.ts:181-183` already parses the completion marker on OBSERVE, but no prompt tells the model it may emit it there (`LOOP_RUN_CONTEXT_PROMPT` says "On REFLECT"). Add the early-exit sentence to the first step's prompt (see 1.1) and mention it in `LOOP_RUN_CONTEXT_PROMPT` (`runner.ts:130`). Saves an entire iteration whenever the previous one actually finished.

### 1.3 Send framing once per session, not per step

`buildOpenCodePrompt` (`runner.ts:151-183`) wraps every step in `## Task` + `## Context` (system prompt + loop context). Within a shared session that block is replayed on every turn.

- In `runLoopStep`, only include the `## Context` block when the step is the **first turn after session start/rotation**; later steps in the same session send just the interpolated step directive.
- Micro-win for Ollama KV-cache prefix reuse: reorder to static `## Context` **before** the changing `## Task`.

### 1.4 Host-side stall detection

Git checkpoints are already captured after each step (`captureGitStatusCheckpoint`). Track files-changed per iteration in `runLoopJob`:

- If **2 consecutive iterations** end with zero new file changes and no completion signal → exit early with a clear failure message (or inject an escalation line into the next iteration's first step, then fail on the 3rd).

### 1.5 Don't discard work at max_iterations

`loop-run-flow.ts:402-413` throws on `max_iterations`. Change: if file changes exist, treat as **completed with warning** (`"Reached max iterations without completion signal"`) and commit/push; only fail when there are no changes. Keep current behavior behind a config flag if strictness is wanted (`failOnMaxIterations`).

---

## 2. Handoffs

### 2.1 Templated, capped REFLECT output

- REFLECT prompt demands a fixed shape, ≤150 words:
  ```
  DONE: …
  REMAINING: …
  NEXT: …
  FILES TOUCHED: …
  ```
- Code safety net in `runLoopStep`: cap injection — `previousIterationSummary.slice(0, 2000)`.

### 2.2 Plan file as the ledger

- INITIAL_PLAN writes `loop-plan.md` as a **markdown checklist** (see §4).
- REFLECT prompt: "Update `.localagent-box/loop-plan.md`, ticking completed items." (REFLECT keeps write access for this — or the host appends the REFLECT summary to the file itself; decide during implementation.)
- Durable state then lives in a file read on demand; the injected summary shrinks to a couple of lines, and progress is visible in the workspace/UI for free.

### 2.3 Inject host-known ground truth

Prepend to each iteration's first step (in `runLoopStep`, alongside `previousIterationSummary`):

```
## Changes so far (host-generated)
<output of `git diff --stat <baseBranch>...HEAD` + `git status --short`, truncated ~15 lines>
```

Deterministic, ~10 lines, and replaces the tool calls OBSERVE currently spends rediscovering (or hallucinating) what changed. Needs a small `gitService` helper (diffstat vs base).

---

## 3. Tools

### 3.1 Repo-configured check command (highest-value addition)

- Add optional `checkCommand` (string) to repo config (`.localagent-box/config.json`, `repo-config.ts`).
- After ACT, the **host** runs it in the workspace (bounded timeout, e.g. 120s; capture last ~50 lines).
- Inject result into the REFLECT prompt:
  ```
  ## Check result (host-run: `npm test`)
  exit=1
  <output tail>
  ```
- **Gate completion:** in `runLoopStep`, ignore the completion marker on REFLECT when the latest check failed (log why). Removes the main hallucinated-success path and much of the need for the negation/echo heuristics in `parseCompletionSignal`.

### 3.2 Read-only agent for non-ACT steps

Every turn currently sends `agent: 'build'` (`session-orchestrator.ts` `runTurn`). OpenCode ships a `plan` agent (write/edit disabled).

- Add optional `agent` field to `LoopStepConfig` (default: `build` for ACT/INITIAL_PLAN, `plan` for ORIENT/REFLECT — note REFLECT needs write if it updates the ledger per §2.2, otherwise `plan`).
- Thread through `runLoopStep` → `runTurn` → `sendPromptAsync`.
- Prevents small models wandering into edits during planning and trims tool schemas from context.

### 3.3 Explicit `num_ctx` for Ollama models

Ollama defaults to a small context (often 4–8k); heavy steps silently truncate the head of the conversation. Reuse the `extraBody` mechanism from the Gemma workaround (`opencode-config.ts:88-93`):

- Add `opencodeNumCtx` (number, optional) to `AppConfig`/Settings; when set, `buildModelConfig` emits `options.extraBody.num_ctx`.

### 3.4 Per-verb token telemetry

Token usage is already aggregated per session. Also record per-step: attach `{ inputTokens, outputTokens }` deltas to `emitLoopStepEnd` payload and the log line. One run's breakdown shows exactly which verb to cut or downsize via `loopVerbModels`.

### 3.5 Non-goals

- No default MCP servers — extra tool schemas cost tokens every turn and confuse small models. Docs-lookup/webfetch only per-repo when a task needs it.

---

## 4. Initial plan

### 4.1 Verify the plan file was written

After the INITIAL_PLAN step in `runLoopJob`:

1. Check `.localagent-box/loop-plan.md` exists and is non-empty.
2. If missing → retry once with a pointed prompt ("You did not write the file. Write it now, nothing else.").
3. Still missing → host writes the raw assistant text into the file itself.

All downstream prompts can then drop the "when present" hedging.

### 4.2 Host-generated repo map in the INITIAL_PLAN prompt

Prepend deterministic context (a few hundred tokens replacing dozens of exploratory tool calls):

- `git ls-files` truncated/tree-formatted (~100 entries max)
- First ~40 lines of `README.md` (when present)
- `package.json` scripts (or equivalent manifest section) when present

Implement as a helper in `workspace-setup.ts` or a new `repo-map.ts`; interpolate via a new `{{repoMap}}` template variable in `loop-config.ts`.

### 4.3 Bound the plan to the iteration budget

INITIAL_PLAN prompt: *"Write at most {{maxIterations}} milestones, each completable in one iteration, ordered, as a markdown checklist."* Add `{{maxIterations}}` to `InterpolateVars`.

### 4.4 Trivial-goal escape hatch

Fold into the prompt: "If the goal is trivially small, write a one-line plan and note it." Optionally expose a per-agent create flag `skipInitialPlan` later; not required for v1.

---

## Suggested implementation order

| Phase | Items | Touches |
|-------|-------|---------|
| 1 | 1.1 merged ORIENT step, 1.2 early exit, 2.1 templated/capped handoff | `loop.default.json`, `runner.ts`, `loop-run-flow.ts` |
| 2 | 2.3 diffstat injection, 4.1 plan-file verification, 4.2 repo map, 4.3 budgeted plan | `loop-run-flow.ts`, `loop-config.ts`, `git-service.ts`, `workspace-setup.ts` |
| 3 | 3.1 check command + completion gating, 1.4 stall detection, 1.5 max-iterations softening | `repo-config.ts`, `loop-run-flow.ts` |
| 4 | 1.3 framing once per session, 3.2 per-step agent, 3.3 num_ctx, 3.4 per-verb telemetry | `runner.ts`, `session-orchestrator.ts`, `opencode-config.ts`, `agent-state-writer.ts` |

Each phase is independently shippable; phase 1 alone should cut per-iteration input tokens by roughly a third to a half on the default config.
