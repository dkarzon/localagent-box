Repo-level configuration lets you override agent behavior per-repository instead of globally in server settings. There are three files, all optional, placed inside `.localagent-box/` at the repository root.

## File locations

| File | Purpose |
|---|---|
| `.localagent-box/config.json` | Prompt overrides (system prompt + run-mode context prompts) |
| `.localagent-box/environment.json` | Host-run workspace bootstrap (setup, runtime profiles, lockfile auto-detect) |
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

Host-run environment bootstrap: the server runs your setup command **once per agent start**, before the OpenCode session begins, so dependency installation does not have to be discovered by the agent.

Which command runs is resolved in this order:

1. Explicit `setup.command` (always wins when present).
2. `profiles` — names runtime profiles whose `defaultSetup` command is used.
3. Lockfile auto-detect — infer a profile from files in the workspace root (see [Detection order](#detection-order)).
4. Nothing matched → bootstrap skipped, the agent starts as before.

```jsonc
// .localagent-box/environment.json (example)
{
  "version": 1,
  "profiles": ["nodejs-pnpm"],
  "setup": {
    "command": "pnpm install --frozen-lockfile && pnpm run build:deps"
  }
}
```

If the file is absent, bootstrap is skipped unless the server enables global lockfile auto-detect (see [Lockfile auto-detect](#lockfile-auto-detect)).

### `version` *(number, required)*

Must be exactly `1`. Schema version — any other value is rejected when the file is loaded.

### `setup` *(object, optional)*

When present, declares the host-run setup step.

#### `setup.command` *(string, required)*

The shell command run in the workspace root before the agent starts. Workspaces are fresh-cloned before every agent run; when the [dependency cache](#dependency-cache-`cacheKey`) is enabled the host restores the cached dependencies before running this command. A non-zero exit fails the agent start by default (see `setup.failOnError`).

#### `setup.timeoutMs` *(number, optional)*

Timeout in milliseconds before the shell is killed. Must be a positive integer no greater than `1800000` (30 min). Defaults to `600000` (10 min).

#### `setup.failOnError` *(boolean, optional, default true)*

When `true` (default), a non-zero exit code (or timeout) from `setup.command` **fails the whole agent** — OpenCode never starts. Set to `false` to log the failure and continue anyway.

### `profiles` *(array, optional)*

Names of **runtime profiles** to apply instead of auto-detecting from lockfiles. The host looks up each name in the server-bundled catalog (`config/runtime-profiles.json`) and runs the profile's `defaultSetup` command.

- When present and non-empty, the **first** profile that exists in the catalog and is enabled on the server wins; unknown or disabled names are skipped (with a warning line in the worker log) and detection is **not** attempted.
- When all requested profiles are skipped, bootstrap is skipped for the run.

```jsonc
// .localagent-box/environment.json
{
  "version": 1,
  "profiles": ["nodejs-pnpm"]
}
```

### `autoDetect` *(boolean, optional, default true)*

Controls lockfile inference for repos that have a file but **no** `setup.command` and **no** `profiles`:

- `true` (default, or omitted) — infer a profile from the workspace lockfiles (see [Detection order](#detection-order)).
- `false` — skip detection; bootstrap is skipped for the run.

 > `autoDetect: false` does **not** affect `setup.command` (still runs) or `profiles` (still resolved).

### Dependency cache — `cacheKey` *(string, optional)*

Speeds up repeat agent runs by persisting installed dependencies (`node_modules/` for the `nodejs` / `nodejs-pnpm` profiles) in a cache volume. The cache is **off by default**; the operator must enable it (`DEP_CACHE_ENABLED=1`, root defaults to `<dataDir>/dep-cache`, override with `DEP_CACHE_ROOT`).

Cache entries live under `{dep-cache-root}/{repo}/{cacheKey}`. When the cache is enabled and a cacheable profile resolves, the host:

1. Restores the cached `node_modules` into the fresh clone **before** the setup command runs (logged as `Dependency cache hit/miss`).
2. After a successful setup command, re-snapshots the workspace back into the cache.

How `cacheKey` is derived when the cache is enabled:

| Source | Determination |
|--------|---------------|
| Explicit `cacheKey` (below) | Sanitized to alphanumerics and hyphens (leading `-` and anything non-path-safe stripped, capped at 200 chars); keys that sanitize to empty (`""`, path-traversal names) fall back to hashing. |
| Nothing usable in the file | SHA-256 over the active profiles' lockfile contents plus the profile names; when no lockfile exists at all, the key is the stable `unknown` segment. |

```jsonc
// .localagent-box/environment.json
{
  "version": 1,
  "profiles": ["nodejs-pnpm"],
  "cacheKey": "acme-monorepo-pnpm9"
}
```

Use `cacheKey` when you want a stable, human-readable cache slot that doesn't change with every lockfile churn (e.g. pin it to a toolchain pin or a dependency batch name). When the lockfile changes but the key doesn't, the host still runs the setup command, so the entry is refreshed. Keys are composed of a per-repo segment + a per-key segment, so the same key in different repos is shared.

### Runtime profile catalog

The host ships a catalog of toolchain profiles in `config/runtime-profiles.json`. Each entry declares the files that detect it and the `defaultSetup` command the host runs:

| Profile | Detected by | `defaultSetup` |
|---|---|---|
| `nodejs` | `package.json` | `npm ci --ignore-scripts` |
| `nodejs-pnpm` | `pnpm-lock.yaml` | `corepack enable && pnpm install --frozen-lockfile` |
| `nodejs-yarn` | `yarn.lock` | `yarn install --frozen-lockfile` |
| `python` | `pyproject.toml`, `requirements.txt` | `python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt` |
| `go` | `go.mod` | `go mod download` |
| `rust` | `Cargo.toml` | `cargo fetch` |

### Detection order

When lockfiles are inferred, every profile with a detect file present in the workspace root and enabled on the server is a candidate; the first one in this priority order wins:

| Workspace-root file | Profile |
|---|---|
| `pnpm-lock.yaml` | `nodejs-pnpm` |
| `package-lock.json` | `nodejs` |
| `yarn.lock` | `nodejs-yarn` |
| `go.mod` | `go` |
| `Cargo.toml` | `rust` |
| `requirements.txt` / `pyproject.toml` | `python` |

Because `package.json` is present in every Node repo, pnpm/yarn take priority: a workspace with both `pnpm-lock.yaml` and `package.json` resolves to `nodejs-pnpm`, to `nodejs-yarn` for a yarn lockfile, or to `nodejs` only when only `package.json` matches.

### Server-side profile gate

Operators can restrict which profiles are allowed on the server before touching any repo config:

- **Enabled profiles** — the server setting `enabledRuntimeProfiles` (a list of names; omitted/empty = all catalog profiles) filters both detected and explicitly requested profiles. A name not in the list is skipped with a worker-log warning.
- **Global auto-detect** — the `BOOTSTRAP_AUTO_DETECT=1` env enables lockfile inference even for repos with **no** `environment.json` (default off; see [Lockfile auto-detect](#lockfile-auto-detect)).
- **Global timeout** — `BOOTSTRAP_SETUP_TIMEOUT_MS` (ms, `0` = off) overrides `setup.timeoutMs` for every repo on this server.

## Lockfile auto-detect

When a repo has no runnable setup command of its own — no `setup.command` and no `profiles` — the host infers a runtime profile from the files at the workspace root instead of requiring explicit config.

The full resolution order, in the order the worker enforces it:

1. `setup.command` — explicit, whenever present and non-empty.
2. `profiles` — first enabled match when the array is non-empty; detection is **not** attempted when `profiles` is declared.
3. Lockfile detection — unless the file explicitly sets `autoDetect: false`.
4. Skipped — nothing above produced a command.

**Opt-out / safety:**

- A repo with **no** `environment.json` is never auto-detected on its own — only when the operator enables server-wide `BOOTSTRAP_AUTO_DETECT=1` (file-less auto-detect, default off).
- `autoDetect` only governs the detection step: `setup.command` and `profiles` are still resolved when present, so `autoDetect: false` never disables them.

Treat detection as a zero-config convenience for standard stacks — `setup.command` or `profiles` remain the deterministic choice for anything unusual.

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
