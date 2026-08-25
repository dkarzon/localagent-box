# Loop mode — token efficiency improvements

Reduce input/output token spend per loop run against small local models (llama3.2-class, modest context windows). Two themes: **shrink what each turn has to read** (fewer steps, less repeated framing, bounded handoffs) and **move deterministic work from the model to the host** (repo map, diffstat, check command, plan-file verification).

**Status:** Mostly implemented (phases 1–2 + partial phase 4). Remaining high-value work is phase 3 (check command, stall already done) and phase 4 leftovers (plan-file verify, `{{maxIterations}}`, per-step agent / `num_ctx` / telemetry), plus new §5 ideas.

**Related:** [loop-verb-models.plan.md](./loop-verb-models.plan.md), [one-shot-batch-options.md](./one-shot-batch-options.md), `src/domains/agents/worker/loop-run-flow.ts`, `src/domains/agents/worker/loop-config.ts`, `src/domains/agents/worker/workspace-setup.ts`, `src/integrations/opencode/runner.ts`, `src/integrations/opencode/session-orchestrator.ts`, `config/loop.default.json`

---

## Status board

| Item | Status | Notes |
|------|--------|-------|
| 1.1 Merge OBSERVE+PLAN → ORIENT | **Done** | Default steps are ORIENT → ACT → REFLECT; legacy verbs normalized |
| 1.2 Early exit on first step | **Done** | ORIENT prompt + `LOOP_RUN_CONTEXT_PROMPT` allow marker on first step |
| 1.3 Framing once per session | **Done** | `includeFraming: stepIndex === 0`; Context before Task for KV-cache |
| 1.4 Host-side stall detection | **Done** | 2 identical porcelain statuses → exit `stalled` |
| 1.5 Soft max-iterations | **Done** | Commits partial work unless `failOnMaxIterations` |
| 2.1 Templated / capped REFLECT | **Done** | Fixed DONE/REMAINING/NEXT/FILES shape; inject cap 2000 chars |
| 2.2 Plan file as ledger | **Done** (prompt-side) | INITIAL_PLAN writes checklist; REFLECT ticks items. Host does not verify/write |
| 2.3 Host change summary | **Done** | `buildHostChangeSummary` on iteration step 0 |
| 3.1 Repo `checkCommand` | **Not started** | Highest remaining host-side win |
| 3.2 Per-step OpenCode agent | **Not started** | Still hardcoded `agent: 'build'` |
| 3.3 `opencodeNumCtx` | **Not started** | Gemma `extraBody` exists; no general `num_ctx` |
| 3.4 Per-verb token telemetry | **Partial** | Session totals + per-message log lines; `emitLoopStepEnd` has no token deltas |
| 4.1 Verify plan file written | **Not started** | No post-INITIAL_PLAN existence/retry/host-write |
| 4.2 Host repo map | **Partial** | README + `package.json` scripts only; `git ls-files` list intentionally disabled (`ef116cf`) |
| 4.3 Bound plan to `{{maxIterations}}` | **Not started** | Interpolate vars lack `maxIterations`; prompt says “ordered milestones” only |
| 4.4 Trivial-goal escape hatch | **Not started** | Not in default INITIAL_PLAN prompt |

---

## Background / cost model (current)

- Steps in one iteration still share one OpenCode session; each later step replays prior turns (ORIENT tool I/O → ACT → REFLECT). Input still grows roughly with steps-per-iteration × tool-output size.
- Sessions rotate per iteration (`rotateSession()`). Cross-iteration handoff is capped REFLECT text (`slice(0, 2000)`) plus host change summary on step 0.
- Framing (`## Context`) is sent only on the first turn after create/rotate; follow-ups send the step directive only.
- Default cycle is ORIENT → ACT → REFLECT (3 steps), not OBSERVE → PLAN → ACT → REFLECT.
- Soft cap: max-iterations / stall with file changes → completed + warning (unless `failOnMaxIterations`).

---

## 1. Steps

### 1.1 Merge OBSERVE + PLAN into one ORIENT step — **Done**

Default iteration shape: **ORIENT → ACT → REFLECT**. `LoopVerb` is `'INITIAL_PLAN' | 'ORIENT' | 'ACT' | 'REFLECT'`. Legacy `OBSERVE`/`PLAN` normalize to `ORIENT` at config boundaries.

### 1.2 Early exit on the first step — **Done**

ORIENT prompt and `LOOP_RUN_CONTEXT_PROMPT` both allow `{{completionMarker}}: true` when the goal is already achieved.

### 1.3 Send framing once per session — **Done**

`buildOpenCodePrompt(..., { includeFraming })`; loop uses `includeFraming: stepIndex === 0`. Static `## Context` before changing `## Task`.

### 1.4 Host-side stall detection — **Done**

`runLoopJob` compares porcelain status across iterations; `noProgressStreak >= 2` → `stalled`.

### 1.5 Don't discard work at max_iterations — **Done**

Soft-cap commit path + optional `failOnMaxIterations` in `loop.json`.

---

## 2. Handoffs

### 2.1 Templated, capped REFLECT output — **Done**

Default REFLECT prompt uses DONE/REMAINING/NEXT/FILES TOUCHED, ≤150 words. Injection capped at `MAX_INJECTED_SUMMARY_CHARS` (2000).

### 2.2 Plan file as the ledger — **Done** (prompts only)

INITIAL_PLAN / REFLECT instruct the model to own `.localagent-box/loop-plan.md`. Host still does not read, tick, or verify the file (see 4.1 and §5.1).

### 2.3 Inject host-known ground truth — **Done**

`buildHostChangeSummary` prepends `git status --short` (+ diffstat totals) to the first step of each iteration (not INITIAL_PLAN).

---

## 3. Tools — remaining

### 3.1 Repo-configured check command — **Not started** (highest remaining addition)

- Add optional `checkCommand` to `.localagent-box/config.json` / `repo-config.ts`.
- After ACT, host runs it (timeout ~120s; last ~50 lines).
- Inject into REFLECT; ignore completion marker on REFLECT when check failed.

### 3.2 Read-only agent for non-ACT steps — **Not started**

`runTurn` still sends `agent: 'build'`. Optional `agent` on `LoopStepConfig` (default `plan` for ORIENT; REFLECT depends on whether it must write the ledger — prefer host-tick §5.2 so REFLECT can stay `plan`).

### 3.3 Explicit `num_ctx` for Ollama models — **Not started**

Reuse `extraBody` from Gemma workaround in `buildModelConfig`: optional `opencodeNumCtx` → `options.extraBody.num_ctx`.

### 3.4 Per-verb token telemetry — **Partial**

Per-message usage is logged and rolled into agent `tokenUsage`. Still missing: attach `{ inputTokens, outputTokens }` deltas on `emitLoopStepEnd` / step log line for verb-level breakdown.

### 3.5 Non-goals

- No default MCP servers for token reasons. `codegraph` remains opt-in via env — when enabled it adds MCP tool schemas every turn; keep that in mind for small-context models.

---

## 4. Initial plan

### 4.1 Verify the plan file was written — **Not started**

After INITIAL_PLAN: exist + non-empty → retry once → else host-write assistant text. Unlocks dropping “when present” hedges in ORIENT.

### 4.2 Host-generated repo map — **Partial**

`buildRepoMap` injects README (~40 lines) + `package.json` scripts. Tracked-file list was implemented then **intentionally disabled** (commit `ef116cf`) — re-enable only if a compact tree proves cheaper than exploratory Glob/Read, or gate behind a config flag.

### 4.3 Bound the plan to the iteration budget — **Not started**

Add `{{maxIterations}}` to `InterpolateVars` / `interpolateStepPrompt` and teach INITIAL_PLAN: at most N checklist items.

### 4.4 Trivial-goal escape hatch — **Not started**

One-line plan note in INITIAL_PLAN prompt; optional `skipInitialPlan` later.

---

## 5. Further opportunities (investigated, not yet planned as work)

Ranked by likely impact on small local models:

### 5.1 Host-inject unfinished plan items (high)

ORIENT still spends a Read (and its output in session history) to rediscover `.localagent-box/loop-plan.md`. Host should read the file, extract unchecked `- [ ]` lines (truncated), and prepend:

```
## Plan ledger (host)
- [ ] …
```

Then ORIENT prompt can say “use the ledger above” and skip the Read. Pairs with 4.1.

### 5.2 Host-tick the ledger; keep REFLECT read-only (high with 3.2)

Today REFLECT must write to tick boxes, which forces `build` + write tools. Prefer: parse REFLECT’s DONE/FILES (or ACT’s git diff) on the host and update `loop-plan.md`. REFLECT becomes evaluation-only → `plan` agent, smaller tool schema, less edit drift.

### 5.3 Mid-iteration session rotate after ORIENT (high, tradeoff)

Largest remaining quadratic cost inside an iteration is replaying ORIENT’s tool transcripts into ACT and REFLECT. After ORIENT, rotate and inject a short host summary (“Next change: …”) instead of the full explore transcript. Tradeoff: ACT loses ORIENT’s raw file contents unless the host also injects a small file pack.

### 5.4 Deduplicate instruction stack (medium)

Every turn can stack OpenCode’s built-in system + repo `AGENTS.md` + `localagent-instructions.md` (tool guidance + optional Settings system prompt) + loop `## Context` (senior-engineer + loop mode text). Overlap with `AGENTS.md` and batch-only paragraphs in tool instructions wastes fixed tokens on every call. See also [one-shot-batch-options.md](./one-shot-batch-options.md) (“Shorter AGENTS.md for batch”). Loop-specific trim: drop batch-only section from instructions when `runMode === 'loop'`, and avoid restating unattended/minimal-diff rules already in `AGENTS.md`.

### 5.5 Drop repeated Goal/Iteration on follow-up steps (low–medium)

Default ACT/REFLECT templates re-append `Goal:` / `Iteration:` even though step 0 framing already carried them; within-session replay pays twice. Keep on step 0 only (or rely on injected host summary).

### 5.6 Cap / strip ORIENT assistant verbosity before handoff (low–medium)

If mid-iteration rotate (§5.3) is too aggressive, at least parse ORIENT text for a one-line “next change” and prefer that in logs/UI; optionally discourage long ORIENT prose in the prompt (“≤80 words, no file dumps”).

### 5.7 Mode-aware tool guidance file (low)

`config/opencode-tool-instructions.md` always includes a “Batch (one-shot) runs” section. Emit a loop variant without that block (or a short loop block pointing at ORIENT/ACT/REFLECT duties).

---

## Suggested implementation order (updated)

| Phase | Items | State |
|-------|-------|-------|
| 1 | 1.1 ORIENT, 1.2 early exit, 2.1 handoff cap | **Shipped** |
| 2 | 2.3 diffstat, 4.2 repo map (partial), framing 1.3, stall 1.4, soft cap 1.5, ledger prompts 2.2 | **Shipped** (4.2 file list off) |
| 3 | 3.1 check command + completion gating | **Next** |
| 4 | 4.1 plan-file verify, 4.3 `{{maxIterations}}`, 4.4 trivial escape; then 5.1 host-inject ledger | **Next** |
| 5 | 3.2 per-step agent (+ 5.2 host-tick), 3.3 num_ctx, 3.4 step telemetry | Open |
| 6 | 5.3 mid-iteration rotate, 5.4–5.7 instruction / prompt trim | Open (measure with 3.4 first) |

Phase 1 alone was the large cut (4 → 3 steps). The next biggest wins are **host check command (3.1)**, **host plan ledger inject/verify (4.1 + 5.1)**, and optionally **dropping ORIENT tool history from ACT (5.3)**.
