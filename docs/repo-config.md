Repo-level configuration lets you override agent behavior per-repository instead of globally in server settings. There are three files, all optional, placed inside `.localagent-box/` at the repository root.

## File locations

| File | Purpose |
|---|---|
| `.localagent-box/config.json` | Prompt overrides (system prompt + run-mode context prompts) |
| `.localagent-box/environment.json` | Host-run workspace bootstrap (setup command) |
| `.localagent-box/loop.json` | Loop-agent orchestration configuration |

Each file is optional. If absent, the server defaults apply.

## `.localagent-box/config.json` — Prompt Overrides

Prompt and behavioural overrides that let each repository customise how agents interact with it. All keys are optional; only include the ones you need to change. Each value must be a non-empty string.

```jsonc
// .localagent-box/config.json (example)
{
  "systemPrompt": "...",
  "batchContextPrompt": "...",
  "interactiveContextPrompt": "...",
  "loopContextPrompt": "...",
  "reviewBackground": "..."
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

### `reviewBackground` *(string)*

Preamble passed to [Open Code Review](https://alibaba.github.io/open-code-review/#/docs) as repository-level review instructions when running `mode: review` agents. Merged into OCR's `-b` background alongside per-session `background` and parent-agent context. See [code-review.md](./code-review.md).

## `.localagent-box/environment.json` — Workspace Bootstrap

Host-run environment bootstrap: the server runs your setup command **once per agent start**, before the OpenCode session begins, so dependency installation does not have to be discovered by the agent. This file is only partially implemented — only the fields below are supported today; see [agent-bootstrap.plan.md](./agent-bootstrap.plan.md) for the full roadmap (profiles, auto-detect, `setup.sh`, caching, etc.).

```jsonc
// .localagent-box/environment.json (example)
{
  "version": 1,
  "setup": {
    "command": "npm ci && npm run build"
  }
}
```

If the file is absent (or has no `setup.command`), bootstrap is skipped and the agent starts as before.

### `version` *(number, required)*

Must be `1`. Schema version — rejects other values.

### `setup` *(object, optional)*

When present, declares the host-run setup step.

#### `setup.command` *(string, required)*

The shell command run in the workspace root before the agent starts. Workspaces are fresh-cloned before every agent run, so this command runs every time (a dependency cache is planned — see [agent-bootstrap.plan.md](./agent-bootstrap.plan.md)). A non-zero exit fails the agent start by default (see `setup.failOnError`).

#### `setup.timeoutMs` *(number, optional)*

Timeout in milliseconds before the shell is killed. Must be a positive integer no greater than `1800000` (30 min). Defaults to `600000` (10 min).

#### `setup.failOnError` *(boolean, optional, default true)*

When `true` (default), a non-zero exit code (or timeout) from `setup.command` **fails the whole agent** — OpenCode never starts. Set to `false` to log the failure and continue anyway.

### Minimum complete example

```json
{
  "version": 1,
  "setup": {
    "command": "echo bootstrap-ok"
  }
}
```

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
