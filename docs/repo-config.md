Repo-level configuration lets you override agent behavior per-repository instead of globally in server settings. The files below are all optional and live inside `.localagent-box/` at the repository root.

## File locations

| File | Purpose |
|---|---|
| `.localagent-box/config.json` | Prompt overrides (system prompt + run-mode context prompts) |
| `.localagent-box/environment.json` | Host-run workspace bootstrap (setup, runtime profiles, lockfile auto-detect) and post-run checks |
| `.localagent-box/setup.sh` | Committed setup script that takes precedence over all `environment.json` sources |

Each file is optional. If absent, the server defaults apply.

## `.localagent-box/config.json` — Prompt Overrides

Prompt and behavioural overrides that let each repository customise how agents interact with it. All keys are optional; only include the ones you need to change. Each value must be a non-empty string.

```jsonc
// .localagent-box/config.json (example)
{
  "systemPrompt": "...",
  "batchContextPrompt": "...",
  "review": { "background": "..." }
}
```

### `systemPrompt` *(string)*

Replaces the system prompt for all agent runs in this repository. Priority when building a prompt: job-level system prompt → repo `systemPrompt` → server default (`SENIOR_ENGINEER_SYSTEM_PROMPT`). Affects both modes (batch and review).

### `batchContextPrompt` *(string)*

Replaces the default batch-mode context paragraph. Default:

> Batch: one unattended run — implement the task in this session (edit files, run checks). Do not stop at a plan or overview; the host fails the run if there are no file changes when you go idle.

Use to relax constraints (e.g., allow planning only) or tighten them for repo-specific conventions.

### Unknown keys *(ignored with a note)*

Keys other than `systemPrompt`, `batchContextPrompt`, `reviewBackground`, and `review` are not read; they are reported to the agent log as `Ignoring unknown keys in .localagent-box/config.json: a, b`. The keys from modes removed in v1 (`interactiveContextPrompt`, `loopContextPrompt`, `checkCommand`) fall in that group, so a repo file that still has them loads unchanged and gains a warning line.

### `review` *(object)*

Repository-specific instructions for [Open Code Review](https://alibaba.github.io/open-code-review/#/docs) (`mode: review` agents). All fields are optional.

```jsonc
"review": {
  "background": "Payments service. Money values are integer cents.",
  "riskAreas": [
    { "paths": ["src/auth/**", "src/session/**"], "description": "Token expiry and scope checks", "risk": "high" },
    { "description": "Anything that changes how invoices are totalled" }
  ],
  "exclude": ["**/generated/**", "fixtures/**"],
  "effort": "high",
  "replaceDefaultRules": false
}
```

| Field | Type | Effect |
|---|---|---|
| `background` | string | Free-text review instructions, added after the built-in default review rules |
| `riskAreas` | array (1–50) | Listed to the reviewer as areas needing extra scrutiny. Each entry: `description` (required), `paths` (gitignore-style globs; omit for a codebase-wide risk), `risk` (`critical` / `high` / `medium` / `low`, a hint to the reviewer, not a forced finding severity) |
| `exclude` | string[] | Passed to OCR `--exclude`; merged with `.opencodereview/rule.json` excludes. Patterns must not contain commas |
| `effort` | `low` / `medium` / `high` | Passed to OCR `--effort` |
| `replaceDefaultRules` | boolean | When `true`, the built-in default review rules (diff-only findings, one posting per issue, no speculative refactors, reachable-failure requirement) are left out, so `background` and `riskAreas` stand alone |

The review background is built in this order: default rules (unless replaced), `background`, `riskAreas`, per-session `background`, parent-agent context. See [code-review.md](./code-review.md).

**Read from the base branch.** For review agents, `.localagent-box/config.json` is read from the PR's base branch, not the branch under review, so a pull request cannot change the instructions it is reviewed under. Config changes take effect for reviews once merged. Coding agents still read the file from their working branch.

#### `reviewBackground` *(string, legacy)*

Same as `review.background`. Setting both is an error.

### Path-specific rules: `.opencodereview/rule.json`

OCR also reads its own rule file, `.opencodereview/rule.json`, from the repository. It attaches rule text to files by glob, which suits checklists that only apply to part of the codebase:

```json
{
  "exclude": ["**/generated/**"],
  "rules": [
    {
      "path": "src/auth/**",
      "rule": "## Auth\n- Every token check must verify expiry and audience",
      "merge_system_rule": true
    }
  ]
}
```

- `path` is a glob. Each file gets the first matching rule.
- `merge_system_rule: true` adds the text to OCR's built-in checklist for that file type; `false` replaces the checklist for matching files.
- Like `config.json`, this file is taken from the base branch for reviews: the host restores the base version into the workspace before OCR runs, or removes the file when the base branch has none.

## `.localagent-box/setup.sh` — Setup Script

A committed shell script the host runs **instead of** any `environment.json` source before the agent starts. The host runs it from the workspace root as `bash .localagent-box/setup.sh`; a non-zero exit is recorded as a failed bootstrap and the error is fed to the agent's first prompt so it can attempt a fix — unless `setup.failOnError: true` is set in `environment.json`, in which case the agent start fails (a timeout behaves the same way). The script must be committed in the repo — like `.localagent-box/environment.json`, it is read straight from the fresh clone before agent commits are ignored.

A committed `setup.sh` **always wins** over `setup.command`, `profiles`, and lockfile auto-detect — commit an `environment.json` without touching the script and the script still runs.

```bash
#!/usr/bin/env bash
# .localagent-box/setup.sh
set -euo pipefail
npm ci
npm run build
```

Prefer `environment.json` for simple installs (it is self-documenting and validated); reach for a script when setup needs multiple steps, database migrations, or generated code that a one-line command can't express.

## `.localagent-box/environment.json` — Workspace Bootstrap

Host-run environment bootstrap: the server runs your setup command **once per agent start**, before the OpenCode session begins, so dependency installation does not have to be discovered by the agent.

Which command runs is resolved in this order:

1. `.localagent-box/setup.sh` — a committed script is run with `bash` and always wins (see [Setup scripts](#`setup.sh`-—-setup-script)).
2. Explicit `setup.command` (always wins when present and no `setup.sh` is committed).
3. `profiles` — names runtime profiles whose `defaultSetup` command is used.
4. Lockfile auto-detect — infer a profile from files in the workspace root (see [Detection order](#detection-order)).
5. Nothing matched → bootstrap skipped, the agent starts as before.

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

If the file is absent (and no `setup.sh` is committed), bootstrap is skipped unless the server enables global lockfile auto-detect (see [Lockfile auto-detect](#lockfile-auto-detect)).

### `version` *(number, required)*

Must be exactly `1`. Schema version — any other value is rejected when the file is loaded.

### `setup` *(object, optional)*

When present, declares the host-run setup step.

#### `setup.command` *(string, required)*

The shell command run in the workspace root before the agent starts. Workspaces are fresh-cloned before every agent run; when the [dependency cache](#dependency-cache-`cacheKey`) is enabled the host restores the cached dependencies before running this command. A non-zero exit is recorded as a failed bootstrap and fed to the agent (see `setup.failOnError`).

#### `setup.timeoutMs` *(number, optional)*

Timeout in milliseconds before the shell is killed. Must be a positive integer no greater than `1800000` (30 min). Defaults to `600000` (10 min).

#### `setup.failOnError` *(boolean, optional, default false)*

Controls what happens when the setup step (or `verifyCommand`) fails:

- `false` (default) — **non-blocking**: the failure is recorded on the agent's `bootstrap` record (`status: 'failed'` with the exit code and output tail) and the run continues; the host prepends a failure block to the agent's first prompt carrying the command, exit code, and output tail so the agent can diagnose and attempt to fix the workspace environment itself.
- `true` — **fail-hard**: a non-zero exit code (or timeout) fails the whole agent — OpenCode never starts.

#### `setup.runOnModes` *(array, optional)*

Agent modes for which the setup runs: `batch` or `review`. When set and the agent's mode is not listed, the bootstrap is **skipped for that run** (the skip reason is logged). Omit to run the setup on every mode. A mode removed in v1 (`interactive`, `loop`) listed here is filtered out with the note `ignored removed mode <x>` instead of failing the load; any other unknown mode is rejected.

### `verifyCommand` *(string, optional)*

Post-setup smoke test run **after** a successful setup command (and before the agent starts). A non-zero exit is handled exactly like a failed setup command under `setup.failOnError`: by default it is recorded (`verifyCommand` and its exit code land on the agent's `bootstrap` record), the run continues, and the error is fed to the agent's prompt for a fix attempt; with `setup.failOnError: true` the agent start fails.

### `verifyTimeoutMs` *(number, optional)*

Timeout in milliseconds for `verifyCommand`. Same constraints as `setup.timeoutMs` (positive integer, max `1800000`). Defaults to the setup timeout — i.e. `setup.timeoutMs` when set, otherwise `600000` (10 min).

### Post-run checks — `checks` *(object, optional)*

Host-run commands executed **after** the model's turn, from the workspace, in `build` → `lint` → `test` order, stopping at the first failure. The run is only reported as successful when these pass. A code failure earns a repair turn (see `repairAttempts`); when those run out the run ends as `needs_attention` with the branch pushed, and a machine failure (timeout, OOM kill, full disk, or a missing command) ends as `failed_machine` without a repair turn.

```jsonc
// .localagent-box/environment.json (example)
{
  "version": 1,
  "checks": {
    "build": "npm run build",
    "lint": "npm run lint",
    "test": "npm test",
    "timeoutMs": 900000
  }
}
```

- Each command must be a non-empty string when provided; `timeoutMs` is a positive integer no greater than `1800000` (30 min) and defaults to `verifyTimeoutMs`, then `600000` (10 min).
- If none of `build`, `lint`, `test` is configured but `verifyCommand` is set, that command runs as a single check named `verify`.
- Nothing configured → the run is recorded as `unverified`; the Checks panel and the PR test plan say so.
- **Read from the base branch**, not the working tree: a run cannot change the checks it is verified under. The base branch is `repo.defaultBranch` for a run on an existing branch, otherwise the branch the run was created from.

The output tail kept per check is the last 200 lines.

### `repairAttempts` *(number, optional, default 2)*

Repair turns allowed after a failing check, 0–3. The host sends the failing check's result block back to the model with a short instruction to fix the cause without changing the check, and re-runs the checks after that turn. Machine failures never use a repair attempt.

### `draftPrOnFailure` *(boolean, optional, default false)*

Allow a draft pull request when checks fail. It applies to a run that ended `needs_attention` (repair attempts used up); machine failures never get a PR.

### Post-setup summary

After the setup command (and, if set, the `verifyCommand`) finishes, the host prepends a short bootstrap block to the agent's first prompt so the model doesn't waste turns rediscovering how to build or test the repo. A **successful** bootstrap reports the resolved command, the runtime profiles, the setup duration, and any dependency-cache hit. A **failed** bootstrap (default `setup.failOnError: false`) reports the failing command, the exit code, the error, and the output tail, instructing the agent to diagnose and fix the environment as part of the task. Only a skipped bootstrap (nothing to run) leaves the prompt untouched.

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

Speeds up repeat agent runs by persisting each package manager's own download cache (the profile's `cacheDirs` in the runtime profile catalog) in a cache volume, plus the workspace `node_modules` for the profiles whose package manager reuses an existing install (`nodejs-pnpm` / `nodejs-yarn`). The cache is **off by default**; the operator must enable it (`DEP_CACHE_ENABLED=1`, root defaults to `<dataDir>/dep-cache`, override with `DEP_CACHE_ROOT`).

Cache entries live under `{dep-cache-root}/{repo}/{cacheKey}`, with the package-manager cache in `{dep-cache-root}/{repo}/{cacheKey}/pm-cache`. When the cache is enabled and a cacheable profile resolves, the host:

1. Points the package manager's cache at `pm-cache` for the setup command via `npm_config_cache` / `npm_config_store_dir` / `YARN_CACHE_FOLDER` / `PIP_CACHE_DIR` / `GOMODCACHE` / `CARGO_HOME`, so a repeat run installs from cache. `npm ci` still installs from scratch — it deletes `node_modules` first — but does so mostly offline.
2. For pnpm/yarn, restores the cached `node_modules` into the fresh clone **before** the command runs (logged as `Dependency cache hit/miss`) and re-snapshots it after a successful run. Copies use `verbatimSymlinks`, so relative links (`node_modules/.bin`, pnpm store links) stay valid instead of being rewritten to point at the run that created them.
3. Reports `hit` only when the cache was already warm or workspace dirs were actually restored — never for a copy the setup command throws away.

Purging a repo's cache (`DELETE /api/v1/repos/{id}/dep-cache`) removes the whole repo directory, including its `pm-cache`.

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

1. `.localagent-box/setup.sh` — the committed setup script wins over every other source when present (see [Setup scripts](#`setup.sh`-—-setup-script)).
2. `setup.command` — explicit, whenever present and non-empty.
3. `profiles` — first enabled match when the array is non-empty; detection is **not** attempted when `profiles` is declared.
4. Lockfile detection — unless the file explicitly sets `autoDetect: false`.
5. Skipped — nothing above produced a command.

**Opt-out / safety:**

- A repo with **no** `environment.json` is never auto-detected on its own — only when the operator enables server-wide `BOOTSTRAP_AUTO_DETECT=1` (file-less auto-detect, default off).
- `autoDetect` only governs the detection step: `setup.command` and `profiles` are still resolved when present, so `autoDetect: false` never disables them.

Treat detection as a zero-config convenience for standard stacks — `setup.command` or `profiles` remain the deterministic choice for anything unusual.

## Removed in v1

`.localagent-box/loop.json` and its server default (`config/loop.default.json`) are no longer read: loop mode was removed in v1, so a repo that still carries the file is simply unaffected — it is not parsed, and the `.gitignore` entry for `.localagent-box/loop-plan.md` is no longer written. Keys belonging to modes removed in v1 are reported as notes rather than being acted on.

