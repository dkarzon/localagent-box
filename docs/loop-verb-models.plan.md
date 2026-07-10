# Loop mode — per-verb models in Settings

Configure **which model runs each loop verb** at the server level (Settings → `DATA_DIR/config.json`), not in repo `loop.json`. Step **prompts** stay in `config/loop.default.json` or `.localagent-box/loop.json`; **models** are a global operator concern alongside `opencodeModel` and `loopAutoApprovePermissions`.

**Status:** Plan (not implemented)

**Related:** [agent-mode-loop.plan.md](./agent-mode-loop.plan.md), [OpenCode agents](https://opencode.ai/docs/agents/)

---

## Goal

Operators set models for each loop verb once in **Settings**. Every loop agent on the server uses those mappings.

Typical use case:

| Verb | Model role |
|------|------------|
| **ACT** | Capable coder model |
| **OBSERVE / PLAN / REFLECT** | Smaller/faster model |
| **INITIAL_PLAN** | Planning-oriented model (optional) |

---

## Config shape

Add one nested object to `AppConfig`:

```typescript
/** Model id on the configured provider (e.g. ollama tag). Empty/missing → fallback. */
export type LoopVerbModels = Partial<Record<LoopVerb, string>>;

export interface AppConfig {
  // ...existing fields...
  loopVerbModels: LoopVerbModels;
}
```

**Defaults** (in `DEFAULT_CONFIG`):

```typescript
loopVerbModels: {
  INITIAL_PLAN: '',
  OBSERVE: '',
  PLAN: '',
  ACT: '',
  REFLECT: '',
},
```

Empty string means “use fallback” (see resolution below).

**Persisted in** `{DATA_DIR}/config.json` — same pattern as `loopAutoApprovePermissions`.

**Exposed via** `GET/PUT /api/v1/config` in `PublicConfig` (no secrets).

---

## Model resolution (runtime)

Single helper used at each loop step.

**After PR 1 (today):**

```
resolveLoopStepModel(verb, { config, job })
  → config.loopVerbModels[verb]   (if non-empty)
  → job.model                     (create-time run fallback, if set)
  → config.opencodeModel          (global default)
  → null                          (OpenCode default)
```

**After PR 3 (per-run verb overrides):**

```
resolveLoopStepModel(verb, { config, job })
  → job.loopVerbModels[verb]      (if non-empty) — this run only
  → config.loopVerbModels[verb]   (if non-empty) — Settings default
  → job.model                     (run-wide fallback for unset verbs)
  → config.opencodeModel
  → null
```

### Precedence rationale

1. **Run verb override (`job.loopVerbModels`)** — most specific; one-off tuning without changing Settings (e.g. try a bigger ACT model on a hard task).
2. **Settings verb default (`config.loopVerbModels`)** — operator baseline for all loop agents on the server.
3. **`job.model`** — single-model fallback for any verb slot left blank at both run and Settings levels; keeps batch/interactive create UX familiar.
4. **`opencodeModel`** — global default when everything else is blank.

Run overrides **merge per verb**, not replace the whole Settings map: blank run slots still inherit Settings for that verb.

**Alternative (stricter):** ignore `job.model` for loop mode and only use verb settings + global default. Simpler mentally but breaks the existing create-form model picker for loop agents. Recommended approach: keep the fallback chain above.

---

## OpenCode integration

Today every loop step sends the same model via `prompt_async` (`agent: 'build'`, single `modelRef` from job/global config). See `src/integrations/opencode/session-orchestrator.ts`.

### Changes

1. **`runTurn`** accepts optional `model?: OpenCodeModelRef` (or model id string resolved upstream).
2. **`runLoopStep`** resolves model from verb + config and passes it in.
3. **`buildOpenCodeConfig`** registers **all distinct models** referenced by the run in `provider.models`, not just the default:
   - Collect: `opencodeModel`, all non-empty `config.loopVerbModels` values, optional `job.loopVerbModels` values (PR 3), optional `job.model`.
   - Dedupe and add each to `provider[providerId].models` (with existing Gemma workaround where needed).
4. **Agent stays `build` for v1** — model-only switching; no OpenCode subagent definitions yet. Permissions remain mode-level (`loopAutoApprovePermissions`).

Per-agent `opencode.json` is still written at worker startup from server config. Verb models are read from the job’s snapshot of config (loaded when worker starts), not re-read mid-run.

---

## Settings UI

Add a section under the existing OpenCode area (near permissions / loop timeout):

**“Loop mode — models per step”**

| Field | Label | Hint |
|-------|-------|------|
| `INITIAL_PLAN` | Initial plan | One-time kickoff before iterations |
| `OBSERVE` | Observe | Read/analyze codebase |
| `PLAN` | Plan | Pick next unit of work |
| `ACT` | Act | Implementation (edits, commands) |
| `REFLECT` | Reflect | Progress check / completion marker |

**Control:** combobox or `<select>` populated from Ollama models (same source as agent create: `/health` → `ollama.models`), with an explicit **“Default (use global model)”** empty option.

**Copy for users:**

> Leave blank to use the global OpenCode model (or the per-agent model override on create). Loop step prompts still come from `config/loop.default.json` or repo `.localagent-box/loop.json`.

Optional UX: “Copy global model to all verbs” button; “Use same model for Observe / Plan / Reflect” preset.

---

## Worker / loop flow (no repo JSON changes)

```
loop-run-flow.ts
  runLoopStep({ verb, ... })
    → modelId = resolveLoopStepModel(verb, config, job)
    → session.runTurn({ promptText, conversationText, model: buildModelRef(modelId) })

startOpenCodeLoopSession
  → buildOpenCodeConfig with extraModels: collectLoopModels(config, job)
  → log: "Loop verb models: ACT=qwen3-coder, REFLECT=llama3.2, ..."
```

**`loop.json` unchanged** — still `verb` + `prompt` only.

---

## Observability

- **Logs:** `Loop step start: iteration=1 step=2 verb=ACT model=qwen3-coder:30b`
- **Events (PR 3):** add `model` to `loop.step.start` payload so the session page shows which model ran each step.
- **Agent record (PR 3):** persist `loopVerbModels` on the agent for audit; optional “Models for this run” summary on session page.

---

## API / validation

| Layer | Behavior |
|-------|----------|
| **PUT /config** | Accept `loopVerbModels` object; validate keys are known `LoopVerb` values; values are non-empty strings or `""` |
| **Save time** | Optional soft warning if model not in Ollama list (don’t block save — models change) |
| **Loop start** | Log resolved models; optional hard fail if Ollama unreachable (already implied by serve startup) |

No new env vars required; optional `LOOP_VERB_MODEL_ACT=...` could be a later addition for Docker-only deployments.

---

## Implementation phases

### PR 1 — Backend (core behavior)

| File | Change |
|------|--------|
| `src/types/index.ts` | `LoopVerbModels`, extend `AppConfig` / `PublicConfig` |
| `src/services/config-store.ts` | Default + `toPublicConfig` |
| `src/domains/agents/worker/loop-model.ts` (new) | `resolveLoopStepModel`, `collectLoopModels` |
| `src/services/opencode-config.ts` | `buildOpenCodeConfig(config, { extraModelIds? })` |
| `src/integrations/opencode/session-orchestrator.ts` | Per-turn `model` param |
| `src/domains/agents/worker/loop-run-flow.ts` | Resolve + pass model per step |
| Tests | Resolution precedence, multi-model opencode config, loop step passes model |

### PR 2 — Settings UI

| File | Change |
|------|--------|
| `client/src/api/types.ts` | Mirror `loopVerbModels` |
| `client/src/pages/SettingsPage.tsx` | Verb model pickers + save/load |
| `README.md` | Document setting + precedence |

### PR 3 — Per-run overrides + observability

Optional follow-up after PR 1–2. Adds **create-time per-verb model overrides** for a single loop agent (parallel to Settings, scoped to one run) plus session visibility.

#### Goal

Operators can override loop step models when starting an agent without editing Settings — useful for one-off experiments, heavier ACT models on a hard goal, or CI/API callers that pass models in the create payload.

Settings remain the server-wide default; run overrides win only for that agent and only for verbs explicitly set on create.

#### Data shape

Reuse `LoopVerbModels` on the job and agent record (same keys as Settings):

```typescript
// CreateAgentRequest (POST /api/v1/agents) — loop mode only
{
  mode: 'loop',
  prompt: '...',
  model?: string,              // run-wide fallback (existing)
  loopVerbModels?: LoopVerbModels,  // per-verb override (new, PR 3)
}

// AgentJob + Agent (persisted snapshot at spawn)
{
  model?: string;
  loopVerbModels?: LoopVerbModels;
}
```

- Omit or send `{}` → no run override; resolution uses Settings + `job.model` as today.
- Empty string on a verb → “no override for this verb on this run”; fall through to Settings, then `job.model`, then global.
- Stored on `Agent` for audit/display on the session page; copied into `job.json` for the worker (same pattern as `model`, `autoApprovePermissions`).

**Not** stored in repo `loop.json` — run config stays server-side, consistent with the design principle at the bottom of this doc.

#### API / validation

| Layer | Behavior |
|-------|----------|
| **POST /agents** | Accept optional `loopVerbModels` when `mode === 'loop'`; ignore or reject for `batch` / `interactive` (recommend **ignore** with no error — simpler API clients). |
| **Sanitize** | Reuse `sanitizeLoopVerbModels` from `src/routes/config.ts` (extract to shared helper if needed). Unknown keys → validation error. |
| **GET /agents/:id** | Return `loopVerbModels` on loop agents so the session UI can show effective config. |

#### Backend changes

| File | Change |
|------|--------|
| `src/types/index.ts` | `loopVerbModels?: LoopVerbModels` on `AgentJob`; optional on `Agent` (or nested under `loop` if preferred — top-level mirrors `model`) |
| `src/domains/agents/dto.ts` | `loopVerbModels?: unknown` on `CreateAgentRequest` |
| `src/domains/agents/agent.validation.ts` | Parse/sanitize `loopVerbModels`; only retain when `mode === 'loop'` |
| `src/domains/agents/agent.service.ts` | Persist on `Agent`, write to job payload |
| `src/domains/agents/worker/loop-model.ts` | PR 3 precedence in `resolveLoopStepModel`; include `job.loopVerbModels` in `collectLoopModels` |
| `src/domains/agents/worker/loop-run-flow.ts` | Pass resolved `model` into `emitLoopStepStart` payload |
| `src/domains/agents/worker/agent-state-writer.ts` | Extend `emitLoopStepStart` payload: `{ iteration, stepIndex, verb, model }` |
| `src/domains/agents/worker/loop-model.test.ts` | Run override beats Settings; blank run slot inherits Settings; collect includes run models |
| `src/domains/agents/agent.validation.test.ts` | Loop create with partial `loopVerbModels`; batch create ignores field |

#### Create-agent UI (`AgentSessionsPage`)

When **mode = loop**, replace the single required “Model” field with a loop-specific block:

| Control | Purpose |
|---------|---------|
| **Fallback model** | Maps to `model`; optional if Settings/global cover all steps. Label: “Fallback model (unset steps)”. Hint: used when this run and Settings both leave a verb blank. |
| **Override step models** (collapsible, default collapsed) | Five verb `<select>`s — same labels/hints as Settings (`LOOP_VERB_LABELS`). Empty option: “Settings default”. |
| **Copy from Settings** | Button: pre-fill overrides from loaded `config.loopVerbModels` (visual aid; user can then edit before start). |
| **Use fallback for all** | Sets all verb overrides empty; user only picks fallback model. |

When **mode = batch** or **interactive**, keep today’s single required model picker unchanged.

**Copy:**

> Loop step models come from Settings unless you override them here. Leave overrides blank to use Settings; leave both blank to use the fallback model or global OpenCode model.

Disable “Start” only when loop mode has no resolvable model path (no Settings verbs, no overrides, no fallback, no global default) — same practical rule as today’s Ollama model requirement for batch.

#### Session page observability

| Item | Change |
|------|--------|
| **`loop.step.start` event** | Add `model: string \| null` to payload |
| **`AgentSessionPage`** | In loop status strip or event timeline, show `verb · model` per step (e.g. `ACT · qwen3-coder:30b`) |
| **Run summary (optional)** | Collapsed “Models for this run” panel: table of verb → resolved source (`run`, `settings`, `fallback`, `global`) at first step only — avoids recomputing on every SSE tick |

Client types: extend `loop.step.start` payload in `client/src/api/agent-events.ts`.

#### Example workflows

**Settings-only (unchanged):**

1. Settings: ACT = `qwen3-coder`, others blank, global = `llama3.2`
2. Create loop agent with goal only → ACT on coder, other steps on `llama3.2`

**Run override without touching Settings:**

1. Settings: ACT = `qwen3-coder`, REFLECT = `llama3.2`
2. Create loop agent with `loopVerbModels: { ACT: 'qwen3-coder:32b' }` → only ACT uses 32b; REFLECT still `llama3.2` from Settings

**Run override + fallback:**

1. Settings: all blank, global = `llama3.2`
2. Create with `model: 'mistral'`, `loopVerbModels: { ACT: 'qwen3-coder' }` → ACT on coder, OBSERVE/PLAN/REFLECT on `mistral`

**API / automation:**

```bash
curl -X POST /api/v1/agents -d '{
  "repoId": "acme-demo",
  "mode": "loop",
  "prompt": "Add retry logic to the webhook client",
  "loopVerbModels": { "ACT": "qwen3-coder:30b", "REFLECT": "llama3.2" }
}'
```

#### Verification (PR 3)

- Unit: precedence matrix (run > settings > job.model > global) for each verb
- Unit: `collectLoopModels` includes run override ids
- Integration: create loop agent with overrides → worker log shows `Loop verb models: ...` including run-specific ids
- UI: loop mode shows override section; batch mode unchanged
- SSE: session page displays model on `loop.step.start`

---

## Out of scope (v2)

| Item | Why defer |
|------|-----------|
| Per-verb **OpenCode agents** (permissions, prompts) | Settings-only **models** is enough for cost/quality tuning; agents add complexity |
| Repo-level model overrides in `loop.json` | System/run settings chosen; avoids drift across repos |
| Per-run overrides at agent create | **In scope — PR 3** (`job.loopVerbModels` + optional `job.model` fallback) |
| Task-tool subagents | Non-deterministic; wrong for fixed harness steps |
| Different **providers** per verb | v1 assumes single `opencodeProvider`; all verb models are tags on that provider |

---

## Example operator workflow

**Server defaults (PR 1–2):**

1. Settings → OpenCode model: `llama3.2` (global default)
2. Settings → Loop verb models: ACT = `qwen3-coder:30b`, REFLECT = `llama3.2`, others blank
3. Create loop agent with goal prompt only
4. Harness runs OBSERVE/PLAN/REFLECT on `llama3.2`, ACT on `qwen3-coder:30b`, same session, same `loop.json` prompts

**One-off run override (PR 3):**

1. Same Settings as above
2. Create loop agent → expand “Override step models” → set ACT = `qwen3-coder:32b` only
3. That run uses 32b for ACT; REFLECT still `llama3.2` from Settings; OBSERVE/PLAN use `llama3.2` (Settings blank → global)
4. Session page shows `model` on each loop step in the event stream

---

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Multiple large models loaded in Ollama | Document; operator ensures RAM fits worst-case (usually only one loaded at a time per request) |
| Context still shared across models in one session | Expected; cheap REFLECT still sees full ACT history |
| Config change mid-run | Worker uses config loaded at spawn; acceptable |
| Create-form `model` confuses loop users | PR 3: relabel as “fallback”, collapsible per-verb overrides, precedence in README |
| Run override drift vs Settings | Run snapshot on `Agent`; worker uses job at spawn, not live Settings for overridden verbs |
| Duplicate UI with Settings | Collapse overrides by default; “Copy from Settings” for power users only |

---

## Design principle

Repo config defines **what to do** (prompts, iterations). Server config defines **how to run it** (models, permissions, timeouts) — consistent with `loopAutoApprovePermissions` and `loopAgentTimeoutSeconds`.
