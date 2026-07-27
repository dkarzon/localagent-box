Repo-level configuration lets you override agent behavior per-repository instead of globally in server settings. There are two files, both optional, placed inside `.localagent-box/` at the repository root.

## File locations

| File | Purpose |
|---|---|
| `.localagent-box/config.json` | Prompt overrides (system prompt + run-mode context prompts) |
| `.localagent-box/loop.json` | Loop-agent orchestration configuration |

Either file is optional. If absent, the server defaults apply.

## `.localagent-box/config.json` — Prompt Overrides

Prompt and behavioural overrides that let each repository customise how agents interact with it. All keys are optional; only include the ones you need to change. Each value must be a non-empty string.

```jsonc
// .localagent-box/config.json (example)
{
  "systemPrompt": "...",
  "batchContextPrompt": "...",
  "interactiveContextPrompt": "...",
  "loopContextPrompt": "..."
}
```

### `systemPrompt` *(string)*

Replaces the system prompt for all agent runs in this repository. Priority when building a prompt: job-level system prompt → repo `systemPrompt` → server default (`SENIOR_ENGINEER_SYSTEM_PROMPT`). Affects every mode (batch, interactive, loop).

### `batchContextPrompt` *(string)*

Replaces the default batch-mode context paragraph. Default:

> Batch: one unattended run — implement the task in this session (edit files, run checks). Do not stop at a plan or overview; the host fails the run if there are no file changes when you go idle.

Use to relax constraints (e.g., allow planning only) or tighten them for repo-specific conventions.

### `interactiveContextPrompt` *(string)*

Replaces the default interactive-mode context paragraph. Default:

> Interactive: follow-ups are allowed; the host commits only when the user finishes the session.

### `loopContextPrompt` *(string)*

Replaces the default loop-mode context paragraph, which instructs agents about multi-iteration orchestration and the completion marker format. Default begins with "Loop: unattended multi-step harness…".

## `.localagent-box/loop.json` — Loop Agent Configuration

Loop agents run in iterative cycles (ORIENT → ACT → REFLECT). This file overrides how many iterations they're allowed, when to stop, and what prompts each step receives. Replaces the server default at `config/loop.default.json`.

```jsonc
// .localagent-box/loop.json (example)
{
  "version": 1,
  "maxIterations": 5,
  "completionMarker": "LOOP_COMPLETE",
  "failOnMaxIterations": false,
  "initialPlanPrompt": "...{{goal}}...",
  "steps": [
    { "verb": "ORIENT", "prompt": "...{{goal}}{{completionMarker}}" },
    { "verb": "ACT",    "prompt": "...{{goal}}..." },
    { "verb": "REFLECT","prompt": "...{{goal}}{{completionMarker}}" }
  ]
}
```

### `version` *(number, required)*  
Must be `1`. Schema version — rejects other values.

### `maxIterations` *(number, required)*  
Maximum number of ORIENT/ACT/REFLECT cycles before the run stops. Must be ≥ 1. Replaces server default (5).

### `completionMarker` *(string, required)*  
Token string agents emit to signal the task is done (`"LOOP_COMPLETE"` etc.). The runner watches model output for `{marker}: true`.

### `failOnMaxIterations` *(boolean, optional, default false)*  
When `true`, reaching max iterations or stalling without a completion marker **fails** the run. When `false` (default): partial file changes are committed with a warning instead of discarded.

### `initialPlanPrompt` *(string | null, optional)*  
Optional one-time prompt sent before iteration 1. Typically asks the model to survey the repo then write `.localagent-box/loop-plan.md`. Set to `null` or omit to skip planning entirely. Default is a pre-defined planning prompt in `config/loop.default.json`.

### `steps` *(array, required)*  
The ORIENT → ACT → REFLECT cycle definitions. At least one step required. Each entry:
- **verb** (`"ORIENT"` | `"ACT"` | `"REFLECT"`) — which phase. Legacy aliases `"OBSERVE"` and `"PLAN"` map to `"ORIENT"`.
- **prompt** (string) — template sent for that verb.

### Prompt template variables  

Loop step prompts support these templates (replaced at runtime):

| Variable | Description |
|---|---|
| `{{goal}}` | Agent task description |
| `{{iteration}}` | Current 1-based iteration number |
| `{{completionMarker}}` | The configured completion token |
| `{{repoMap}}` | Codebase map (available in `initialPlanPrompt`) |
