# Plan: Per-Repo Agent Startup & Environment Bootstrap

## Problem

Today, when an agent starts in a repo, the host only does:

1. Wipe + shallow clone
2. Branch checkout
3. `.gitignore` for `.localagent-box/`
4. Optional `codegraph init`

There is **no general bootstrap step** for dependencies or tooling. The OpenCode agent must discover and run `npm ci`, `pip install`, etc. itself — wasting tokens, time, and often failing on the first verification pass.

The closest existing pattern is `checkCommand` in `.localagent-box/config.json`, but that runs **after loop ACT steps only**, not at workspace prep.

```ts
// workspace-setup.ts — prepareWorkspace() ends after clone + optional codegraph
export async function prepareWorkspace(ctx: WorkerContext): Promise<void> {
  // ... clone, branch checkout ...
  ensureLocalagentBoxIgnored(job.workspaceDir);

  if (getServerEnv().enableCodegraph) {
    await initCodegraph(job.workspaceDir, logPath);
  }
}
```

Because workspaces are **wiped before every run**, any install done inside the workspace is lost unless dependencies are cached globally in the container image or on a persistent volume.

---

## Goals

| Goal | Description |
|------|-------------|
| **Ready on start** | Agent workspace has deps installed before OpenCode session begins |
| **Repo-controlled** | Each repo declares what it needs via `.localagent-box/` |
| **App-wide defaults** | Common stacks (Node, Python, Go, etc.) available without per-repo boilerplate |
| **Fast repeat runs** | Cache dependency layers across agent runs where possible |
| **Observable** | Setup phase visible in worker log + agent status API |
| **Safe** | Bounded timeouts, no secrets in repo config, fail-fast by default |

---

## Proposed Architecture

Three layers, applied in order during `prepareWorkspace()`:

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: App-wide runtime profile (server / image)         │
│  node, npm, python, go, rust, pnpm, uv, etc.                │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 2: Repo environment config (.localagent-box/)        │
│  profiles, setup commands, env vars, cache keys             │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: Host-run bootstrap (prepareWorkspace hook)        │
│  detect → cache lookup → run setup → verify                 │
└─────────────────────────────────────────────────────────────┘
```

### Layer 1 — App-wide component catalog

Extend the Docker image (and document for bare-metal installs) with a **runtime catalog** of optional toolchains. These are not installed per-agent; they're pre-baked in the image or enabled via server config.

**Proposed `config/runtime-profiles.json` (server-bundled):**

```jsonc
{
  "profiles": {
    "nodejs": {
      "detect": ["package.json"],
      "defaultSetup": "npm ci --ignore-scripts",
      "tools": ["node", "npm"],
      "cacheDirs": ["~/.npm"]
    },
    "nodejs-pnpm": {
      "detect": ["pnpm-lock.yaml"],
      "defaultSetup": "corepack enable && pnpm install --frozen-lockfile",
      "tools": ["node", "pnpm"],
      "cacheDirs": ["~/.local/share/pnpm/store"]
    },
    "python": {
      "detect": ["pyproject.toml", "requirements.txt"],
      "defaultSetup": "python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt",
      "tools": ["python3", "pip"],
      "cacheDirs": ["~/.cache/pip"]
    },
    "go": {
      "detect": ["go.mod"],
      "defaultSetup": "go mod download",
      "tools": ["go"],
      "cacheDirs": ["~/go/pkg/mod"]
    }
  }
}
```

**Server config extension** (`{DATA_DIR}/config.json`):

```jsonc
{
  "enabledRuntimeProfiles": ["nodejs", "nodejs-pnpm", "python"],
  "globalSetupTimeoutMs": 600000,
  "dependencyCacheRoot": "/data/dep-cache"
}
```

**Dockerfile changes (phased):**

- Phase 1: ensure `corepack`, `uv`/`pip`, `go` are available as optional install targets
- Phase 2: split into `localagent-box:slim` (current) and `localagent-box:full` (all profiles)
- Allow operators to mount a custom image with their org's standard toolchains

This mirrors what's already done for `opencode`, `codegraph`, and `ocr` in the Dockerfile — extend the same pattern to language runtimes.

---

### Layer 2 — Per-repo configuration

Extend `.localagent-box/` with a dedicated environment file. Keep `config.json` for prompts; add `environment.json` for bootstrap.

#### Option A (recommended): `.localagent-box/environment.json`

```jsonc
{
  "version": 1,

  // Inherit app-wide profiles (auto-detect if omitted)
  "profiles": ["nodejs-pnpm"],

  // Override or supplement auto-detected setup
  "setup": {
    "command": "pnpm install --frozen-lockfile && pnpm run build:deps",
    "timeoutMs": 300000,
    "failOnError": true,
    "runOnModes": ["batch", "interactive", "loop"]  // optional filter
  },

  // Env vars injected into setup + agent shell
  "env": {
    "NODE_ENV": "test",
    "CI": "true"
  },

  // Cache key for cross-run dependency reuse (see Layer 3)
  "cacheKey": "myrepo-node22-pnpm9",

  // Post-setup sanity check (distinct from loop checkCommand)
  "verifyCommand": "npm test -- --runInBand --passWithNoTests"
}
```

#### Option B: Script file `.localagent-box/setup.sh`

For complex setups, repos can commit a script instead of inline commands:

```bash
#!/usr/bin/env bash
set -euo pipefail
npm ci
npm run db:migrate:test
```

Host runs: `bash .localagent-box/setup.sh` with timeout and logging. Script must be committed in the repo (not gitignored — unlike other `.localagent-box/` artifacts that agents write).

**Resolution order:**

1. If `setup.sh` exists → run script
2. Else if `environment.json` has `setup.command` → run command
3. Else if `profiles` or auto-detect matches → run profile `defaultSetup`
4. Else → skip (current behavior)

#### Auto-detection (when no explicit config)

If `environment.json` is absent, infer from lockfiles:

| Detected file | Default profile | Default command |
|---------------|-----------------|-----------------|
| `pnpm-lock.yaml` | `nodejs-pnpm` | `pnpm install --frozen-lockfile` |
| `package-lock.json` | `nodejs` | `npm ci` |
| `yarn.lock` | `nodejs-yarn` | `yarn install --frozen-lockfile` |
| `pyproject.toml` | `python` | `pip install -e ".[dev]"` or `uv sync` |
| `go.mod` | `go` | `go mod download` |
| `Cargo.toml` | `rust` | `cargo fetch` |

Auto-detect should be **opt-out** via `"autoDetect": false` in `environment.json`, and **logged** so operators know what ran.

---

### Layer 3 — Host bootstrap execution

Add a new module `workspace-bootstrap.ts`, called from `prepareWorkspace()` after clone/branch checkout and before `initCodegraph()`:

```
prepareWorkspace()
  ├── clone + checkout
  ├── ensureLocalagentBoxIgnored
  ├── runWorkspaceBootstrap()     ← NEW
  │     ├── load environment.json / detect profiles
  │     ├── resolve cache (hit → symlink/copy, skip install)
  │     ├── inject env vars
  │     ├── run setup command or setup.sh
  │     ├── run verifyCommand (optional)
  │     └── write bootstrap manifest to agent data dir
  ├── initCodegraph (if enabled)
  └── return → OpenCode session starts
```

**Reuse existing patterns:**

- Shell execution from `loop-check.ts` (`runLoopCheckCommand`) — extract to shared `runWorkspaceCommand()` with configurable timeout, output tail, process-tree kill
- Config loading from `repo-config.ts` — parallel `environment-config.ts` with validation
- Logging via `appendLog(logPath, ...)`

**Agent status API extension:**

```jsonc
{
  "bootstrap": {
    "status": "running" | "completed" | "failed" | "skipped",
    "profiles": ["nodejs-pnpm"],
    "command": "pnpm install --frozen-lockfile",
    "durationMs": 42000,
    "cacheHit": true,
    "exitCode": 0
  }
}
```

Expose in UI as a "Preparing workspace…" step before "Running agent".

---

## Dependency Caching (critical for performance)

Fresh clones make uncached `npm ci` the dominant cost. Without caching, bootstrap may take longer than the agent's actual work.

### Strategy: persistent dep-cache volume

Mount `/data/dep-cache` (already under persistent `agent-data` volume) and key caches by:

```
/data/dep-cache/
  {repoId}/
    {cacheKey or hash(lockfile)}/
      node_modules/     # or .venv/, go/pkg/, etc.
      manifest.json     # what was installed, when, which command
```

**On bootstrap:**

1. Compute cache key: `environment.cacheKey` or `sha256(lockfile contents + profile name)`
2. If cache hit → restore `node_modules` into workspace (hardlink copy or `rsync -a`)
3. Run setup command (fast if deps already present; `npm ci` still validates)
4. On success → update cache from workspace

**Cache invalidation:**

- Lockfile hash change → miss
- Profile version bump in server catalog → miss
- Manual purge via API: `DELETE /api/repos/{id}/dep-cache`

**Docker compose addition:**

```yaml
environment:
  DEP_CACHE_ROOT: "/data/dep-cache"
  DEP_CACHE_ENABLED: "true"
```

This is the single biggest improvement for repeat agent runs on the same repo.

---

## Relationship to `checkCommand`

Today these serve different purposes:

| Field | When | Purpose |
|-------|------|---------|
| `setup.command` / `setup.sh` | Before agent starts | Install deps, prepare DB, generate code |
| `verifyCommand` | After setup, before agent | Quick smoke test that env is usable |
| `checkCommand` | After each loop ACT step | Iteration feedback for the model |

Consider unifying execution under one `WorkspaceCommandRunner` but keeping config separate. Optionally allow `checkCommand` in all modes (not just loop) as a post-agent verification step — separate follow-up.

---

## Implementation Phases

Phases are sequential. Tasks within a phase can often run in parallel when **Depends on** is empty or already satisfied.

**Verification command for all phases:** `npm test` (runs `tsx --test src/**/*.test.ts`).

**Conventions for implementers:**

- Mirror existing patterns in `repo-config.ts`, `loop-check.ts`, and `workspace-setup.test.ts`.
- Do not commit secrets. Do not modify unrelated files.
- Each task should be a single PR-sized unit (typically 1–3 files + tests).
- Mark a task **done** only when its acceptance criteria pass and `npm test` is green.

### Phase dependency graph

```
Phase 1 (MVP bootstrap)
    │
    ├──► Phase 2 (profiles + auto-detect)
    │         │
    │         └──► Phase 3 (dep cache) ──► Phase 5 (operator tools)
    │
    └──► Phase 4 (scripts + verify + env) ──► Phase 5
```

---

### Phase 1 — Minimal viable bootstrap

**Goal:** Run an explicit `setup.command` from `.localagent-box/environment.json` during `prepareWorkspace()`, before OpenCode starts. Fail the agent on non-zero exit (default). No caching, no auto-detect, no UI.

**Example repo config (for manual testing after Phase 1):**

```json
{
  "version": 1,
  "setup": {
    "command": "npm ci && npm run build"
  }
}
```

---

#### P1-T1 — Add types for environment config and bootstrap result

| | |
|---|---|
| **Depends on** | — |
| **Files** | `src/types/index.ts` |
| **Estimate** | 30 min |

**Steps:**

1. Add `RepoEnvironmentSetupConfig` interface:
   - `command: string` (required when `setup` object present)
   - `timeoutMs?: number`
   - `failOnError?: boolean` (default `true` when omitted at runtime)
2. Add `RepoEnvironmentConfig` interface:
   - `version: 1` (literal type or documented constant)
   - `setup?: RepoEnvironmentSetupConfig`
3. Add `BootstrapStatus` type: `'skipped' | 'running' | 'completed' | 'failed'`
4. Add `AgentBootstrapState` interface (for future API/UI; persist on `Agent` in P1-T5):
   - `status: BootstrapStatus`
   - `command?: string`
   - `durationMs?: number`
   - `exitCode?: number`
   - `outputTail?: string` (last ~50 lines, same cap as loop checks)
   - `error?: string`
5. Add optional `bootstrap?: AgentBootstrapState` to `Agent` interface.

**Acceptance criteria:**

- Types compile with `npm run build`.
- No runtime changes yet.

---

#### P1-T2 — Extract shared workspace command runner

| | |
|---|---|
| **Depends on** | — |
| **Files** | `src/domains/agents/worker/workspace-command.ts` (new), `src/domains/agents/worker/loop-check.ts`, `src/domains/agents/worker/workspace-command.test.ts` (new), `src/domains/agents/worker/loop-check.test.ts` |
| **Estimate** | 1–2 hrs |

**Steps:**

1. Create `workspace-command.ts`. Move shell-spawn logic from `loop-check.ts`:
   - Export `WorkspaceCommandResult` (same shape as `LoopCheckResult`: `command`, `exitCode`, `outputTail`, `timedOut`, `success`).
   - Export `runWorkspaceCommand(workspaceDir, command, options?)` with `timeoutMs`, `maxOutputLines`, `spawnImpl`, `env` (optional env override).
   - Keep `tailOutputLines` here (or re-export from loop-check for backward compat).
   - Preserve Windows vs Linux shell behavior (`cmd.exe /c` vs `sh -c`).
   - Preserve detached process group + SIGTERM/SIGKILL timeout kill logic.
2. Refactor `loop-check.ts` to re-export or thin-wrap `runWorkspaceCommand` as `runLoopCheckCommand` (do not break `loop-run-flow.ts` imports).
3. Move/adapt tests from `loop-check.test.ts` into `workspace-command.test.ts`. Keep `loop-check.test.ts` passing (can test the wrapper still works).

**Acceptance criteria:**

- `runLoopCheckCommand` behavior unchanged (all existing loop-check tests pass).
- New tests cover: exit 0, exit non-zero, timeout, spawn error.
- `npm test` green.

---

#### P1-T3 — Environment config loader and validator

| | |
|---|---|
| **Depends on** | P1-T1 |
| **Files** | `src/domains/agents/worker/environment-config.ts` (new), `src/domains/agents/worker/environment-config.test.ts` (new) |
| **Estimate** | 1–2 hrs |

**Steps:**

1. Create `environment-config.ts` mirroring `repo-config.ts` structure:
   - Constant: `environmentConfigRelative = path.join('.localagent-box', 'environment.json')`
   - `validateEnvironmentConfig(raw: unknown): RepoEnvironmentConfig`
   - `loadEnvironmentConfig(workspaceDir, fsImpl?): RepoEnvironmentConfig | null`
2. Validation rules:
   - Root must be object.
   - `version` must be exactly `1` when file exists.
   - `setup` if present must be object with non-empty `command` string.
   - `setup.timeoutMs` if present: positive integer, max `1_800_000` (30 min).
   - `setup.failOnError` if present: boolean.
   - Unknown top-level keys: ignore (same as `repo-config`).
3. Tests (mirror `repo-config.test.ts`):
   - Missing file → `null`
   - Valid minimal config
   - Invalid JSON → throws with `Failed to load`
   - Bad `version`, empty `command`, bad `timeoutMs`

**Acceptance criteria:**

- `loadEnvironmentConfig` / `validateEnvironmentConfig` fully tested.
- No integration with workspace yet.

---

#### P1-T4 — Bootstrap orchestrator module

| | |
|---|---|
| **Depends on** | P1-T2, P1-T3 |
| **Files** | `src/domains/agents/worker/workspace-bootstrap.ts` (new), `src/domains/agents/worker/workspace-bootstrap.test.ts` (new) |
| **Estimate** | 2–3 hrs |

**Steps:**

1. Create `workspace-bootstrap.ts` with:

```ts
export const DEFAULT_SETUP_TIMEOUT_MS = 600_000; // 10 min

export interface RunWorkspaceBootstrapOptions {
  workspaceDir: string;
  logPath: string;
  agentId: string;
  agentsStore: JsonStore<{ agents: Agent[] }>;
  runCommand?: typeof runWorkspaceCommand; // inject for tests
}

export async function runWorkspaceBootstrap(
  options: RunWorkspaceBootstrapOptions,
): Promise<AgentBootstrapState>
```

2. Logic:
   - `loadEnvironmentConfig(workspaceDir)` → if `null` or no `setup.command`, return `{ status: 'skipped' }`.
   - `appendLog(logPath, 'Running workspace bootstrap…')` and log the command (redact nothing yet; Phase 5 can add secret redaction).
   - Update agent record: `bootstrap: { status: 'running', command }` via `updateAgentRecord`.
   - Call `runWorkspaceCommand` with `timeoutMs = setup.timeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS`.
   - On success (`exitCode === 0`): log output tail, return `{ status: 'completed', command, durationMs, exitCode, outputTail }`.
   - On failure: if `failOnError !== false`, throw `Error` with message like `Bootstrap failed: \`npm ci\` exited 1\n{outputTail}`; else log warning and return `{ status: 'failed', ... }`.
   - Always `appendLog` duration and exit code.
3. Tests (unit, no real shell if possible):
   - Skipped when no config
   - Skipped when config has no `setup`
   - Success path (mock `runCommand` returning exit 0)
   - Failure throws when `failOnError` default
   - Failure does not throw when `failOnError: false`
   - Timeout path (mock `timedOut: true`)
   - Agent record updated (mock `agentsStore`)

**Acceptance criteria:**

- Module is pure orchestration; no clone/git logic.
- All tests pass without network or real `npm ci`.

---

#### P1-T5 — Wire bootstrap into `prepareWorkspace()`

| | |
|---|---|
| **Depends on** | P1-T4 |
| **Files** | `src/domains/agents/worker/workspace-setup.ts`, `src/domains/agents/worker/workspace-setup.test.ts` (extend) |
| **Estimate** | 1 hr |

**Steps:**

1. Import `runWorkspaceBootstrap` in `workspace-setup.ts`.
2. Call it **after** `ensureLocalagentBoxIgnored` and **before** `initCodegraph`:

```ts
await runWorkspaceBootstrap({
  workspaceDir: job.workspaceDir,
  logPath,
  agentId: job.agentId,
  agentsStore: ctx.agentsStore,
});
```

3. Pass `ctx.agentsStore` — verify `WorkerContext` already exposes it (it does via `createWorkerContext`).
4. Bootstrap failure must propagate: `agent-worker.ts` already catches errors from `prepareWorkspace` and sets agent `status: 'failed'`. Confirm error message surfaces in `agent.error`.
5. Add integration-style test in `workspace-setup.test.ts` OR a dedicated test that mocks clone and asserts bootstrap is invoked (optional if P1-T4 coverage is sufficient; at minimum add a test that `runWorkspaceBootstrap` is exported and callable).

**Acceptance criteria:**

- Agent with failing bootstrap never reaches OpenCode (manual or integration test).
- Worker log contains `Running workspace bootstrap` lines.
- `agent.bootstrap.status` is `completed` or `failed` on the agent record after run.

---

#### P1-T6 — Document `environment.json` in repo-config docs

| | |
|---|---|
| **Depends on** | P1-T3 |
| **Files** | `docs/repo-config.md` |
| **Estimate** | 30 min |

**Steps:**

1. Add section **`.localagent-box/environment.json` — Workspace Bootstrap`** after the `config.json` section.
2. Document Phase 1 fields only: `version`, `setup.command`, `setup.timeoutMs`, `setup.failOnError`.
3. Note: runs once per agent start, before OpenCode; failure fails the agent by default.
4. Include minimal example and link to `docs/agent-bootstrap.plan.md`.

**Acceptance criteria:**

- Docs match implemented schema (no references to Phase 2+ fields unless marked "planned").

---

#### Phase 1 — Definition of done

- [ ] All P1-T1 … P1-T6 complete
- [ ] `npm run build && npm test` pass
- [ ] Manual smoke: add `environment.json` with `setup.command: "echo bootstrap-ok"` to a test repo; agent log shows output and agent proceeds to OpenCode

---

### Phase 2 — Profiles and auto-detect

**Goal:** When a repo has no explicit `setup.command`, infer one from lockfiles using a server-bundled profile catalog. Gate profiles via server config.

---

#### P2-T1 — Ship runtime profile catalog

| | |
|---|---|
| **Depends on** | Phase 1 complete |
| **Files** | `config/runtime-profiles.json` (new), `src/domains/agents/worker/runtime-profiles.ts` (new), `src/domains/agents/worker/runtime-profiles.test.ts` (new) |
| **Estimate** | 1–2 hrs |

**Steps:**

1. Add `config/runtime-profiles.json` with profiles from the architecture section (`nodejs`, `nodejs-pnpm`, `nodejs-yarn`, `python`, `go`, `rust`).
2. Each profile: `detect: string[]`, `defaultSetup: string`, `tools: string[]`, `cacheDirs: string[]` (cacheDirs used in Phase 3).
3. Create loader `loadRuntimeProfiles(): Record<string, RuntimeProfile>` that reads bundled JSON from `path.join(__dirname, '../../..', 'config/runtime-profiles.json')` (resolve path same way as `loop.default.json` if a pattern exists — grep for it).
4. Export `getRuntimeProfile(name): RuntimeProfile | undefined`.
5. Tests: catalog loads, known profile keys exist, `defaultSetup` non-empty.

**Acceptance criteria:**

- JSON valid; loader works in dev (`tsx`) and compiled (`dist/`) paths.

---

#### P2-T2 — Lockfile auto-detection resolver

| | |
|---|---|
| **Depends on** | P2-T1 |
| **Files** | `src/domains/agents/worker/environment-detect.ts` (new), `src/domains/agents/worker/environment-detect.test.ts` (new) |
| **Estimate** | 1–2 hrs |

**Steps:**

1. Export `detectProfiles(workspaceDir, profiles): string[]` — returns profile names whose **any** `detect` file exists in workspace root.
2. Detection priority when multiple match (document and implement):
   - `pnpm-lock.yaml` → `nodejs-pnpm` before `nodejs` (package.json)
   - `package-lock.json` → `nodejs`
   - `yarn.lock` → `nodejs-yarn`
   - `go.mod` → `go`
   - `Cargo.toml` → `rust`
   - `pyproject.toml` or `requirements.txt` → `python`
3. Export `resolveSetupCommand(config, workspaceDir, profiles, enabledProfileNames?): { command: string; profiles: string[]; source: 'explicit' | 'profile' | 'detect' | 'none' }`.
4. Resolution order (from architecture):
   - Explicit `config.setup.command` → `source: 'explicit'`
   - Else `config.profiles` (if non-empty) → use first profile's `defaultSetup` (or concatenate if multiple — prefer **first profile only** for v1 simplicity)
   - Else auto-detect (unless `config.autoDetect === false`) → first matching profile's `defaultSetup`
   - Else → `source: 'none'`
5. Tests: temp dirs with fake lockfiles; `autoDetect: false` skips detection.

**Acceptance criteria:**

- Table in architecture section covered by tests.
- No shell execution in this module.

---

#### P2-T3 — Integrate resolver into bootstrap orchestrator

| | |
|---|---|
| **Depends on** | P2-T2, P1-T4 |
| **Files** | `src/domains/agents/worker/workspace-bootstrap.ts`, `src/domains/agents/worker/workspace-bootstrap.test.ts`, `src/types/index.ts` |
| **Estimate** | 1–2 hrs |

**Steps:**

1. Extend `RepoEnvironmentConfig`: `profiles?: string[]`, `autoDetect?: boolean`.
2. Extend `AgentBootstrapState`: `profiles?: string[]`, `source?: 'explicit' | 'profile' | 'detect' | 'none'`.
3. In `runWorkspaceBootstrap`, call `resolveSetupCommand` instead of only reading `setup.command`.
4. Log: `Bootstrap: source=detect profiles=[nodejs-pnpm] command=pnpm install…`
5. If `source === 'none'`, return `{ status: 'skipped' }` (unchanged behavior for repos without config).
6. Update tests for detect path and explicit override.

**Acceptance criteria:**

- Repo with only `package-lock.json` and no `environment.json` still skips (no auto-detect without opt-in) **OR** auto-detect runs when env file absent — **pick one and document**:
  - **Recommended:** auto-detect only when `environment.json` exists with `"autoDetect": true` OR has `"profiles"` array. Absent file = skip. Safer for rollout.
  - If implementing global auto-detect without file: add server env `BOOTSTRAP_AUTO_DETECT=true` (see P2-T4).

---

#### P2-T4 — Server config gate for enabled profiles

| | |
|---|---|
| **Depends on** | P2-T1 |
| **Files** | `src/types/index.ts`, `src/config/env.ts`, `src/services/config-store.ts` (if defaults live there), `src/domains/agents/worker/workspace-bootstrap.ts` |
| **Estimate** | 1–2 hrs |

**Steps:**

1. Add to `AppConfig` (optional fields with defaults):
   - `enabledRuntimeProfiles?: string[]` — default all profiles from catalog
   - `globalSetupTimeoutMs?: number` — default `600_000`
   - `bootstrapAutoDetect?: boolean` — default `false`
2. Add env vars: `BOOTSTRAP_AUTO_DETECT`, `BOOTSTRAP_SETUP_TIMEOUT_MS` (parse in `env.ts`; pass through worker job or read in worker from `config.json`).
3. In `resolveSetupCommand`, filter detected/requested profiles against `enabledRuntimeProfiles`.
4. If requested profile disabled, log warning and skip that profile.
5. Pass `config` into `runWorkspaceBootstrap` (extend options).

**Acceptance criteria:**

- Disabling `nodejs-pnpm` in server config prevents pnpm setup even if lockfile present.
- Defaults preserve Phase 1 behavior (explicit command only).

---

#### P2-T5 — Extend Dockerfile with corepack

| | |
|---|---|
| **Depends on** | P2-T1 |
| **Files** | `Dockerfile`, `docs/docker-hosting.md` (optional note) |
| **Estimate** | 30 min |

**Steps:**

1. In Dockerfile `apt install` stage or a `RUN` after `USER node`, enable corepack: `RUN corepack enable`.
2. Verify image builds: `docker build -t localagent-box .`
3. Document that `nodejs-pnpm` / `nodejs-yarn` profiles require corepack in image.

**Acceptance criteria:**

- `docker build` succeeds.
- `pnpm --version` works inside container (smoke).

---

#### P2-T6 — UI: show bootstrap info on agent session page

| | |
|---|---|
| **Depends on** | P1-T5 (bootstrap on Agent record) |
| **Files** | `client/src/api/types.ts` (or shared types import path), `client/src/components/agents/AgentSessionInfo.tsx` |
| **Estimate** | 1–2 hrs |

**Steps:**

1. Add `bootstrap?: AgentBootstrapState` to client `Agent` type (match server).
2. In `AgentSessionInfo`, when `agent.bootstrap` present, show:
   - Status badge: Skipped / Running / Completed / Failed
   - Command (truncated)
   - Duration, exit code
   - Profiles list (Phase 2+)
3. Only render when status is not `skipped` OR when user would benefit (show "Bootstrap skipped" only in debug — prefer hide when skipped).

**Acceptance criteria:**

- `npm run build:ui` passes.
- No runtime errors when `bootstrap` undefined (legacy agents).

---

#### P2-T7 — Update docs for profiles and auto-detect

| | |
|---|---|
| **Depends on** | P2-T3, P2-T4 |
| **Files** | `docs/repo-config.md` |
| **Estimate** | 30 min |

**Document:** `profiles`, `autoDetect`, server `enabledRuntimeProfiles`, detection table, examples.

---

#### Phase 2 — Definition of done

- [ ] All P2-T1 … P2-T7 complete
- [ ] Repo with `environment.json` `{ "version": 1, "profiles": ["nodejs"] }` and `package.json` runs `npm ci` equivalent
- [ ] UI shows bootstrap result on completed agent

---

### Phase 3 — Dependency caching

**Goal:** Persist `node_modules` (and later `.venv`, etc.) under `/data/dep-cache` keyed by repo + lockfile hash; restore before setup to speed repeat runs.

---

#### P3-T1 — Env and paths for dep cache

| | |
|---|---|
| **Depends on** | Phase 2 complete |
| **Files** | `src/config/env.ts`, `docker-compose.yml`, `.env.example` (if exists) |
| **Estimate** | 30 min |

**Steps:**

1. Add `depCacheRoot: string` (default `path.join(dataDir, 'dep-cache')`), `depCacheEnabled: boolean` (default `false` — opt-in).
2. Env: `DEP_CACHE_ENABLED`, `DEP_CACHE_ROOT`.
3. Document in `docker-compose.yml` comments; `/data` volume already persists cache when root is under `dataDir`.

**Acceptance criteria:**

- Default off; enabling via env works.

---

#### P3-T2 — Cache key computation

| | |
|---|---|
| **Depends on** | P3-T1, P2-T2 |
| **Files** | `src/domains/agents/worker/dep-cache-key.ts` (new), `src/domains/agents/worker/dep-cache-key.test.ts` (new) |
| **Estimate** | 1–2 hrs |

**Steps:**

1. `computeCacheKey({ repoId, profiles, explicitCacheKey?, workspaceDir }): string`
2. If `environment.cacheKey` set → use it (sanitize: alphanumeric + hyphen only).
3. Else hash: SHA-256 of concatenated lockfile contents (`pnpm-lock.yaml`, `package-lock.json`, etc. for active profiles) + profile names.
4. Return `{ repoId }/{cacheKey}` path segment.

**Acceptance criteria:**

- Same lockfile → same key; changed lockfile → different key.

---

#### P3-T3 — Cache restore and snapshot

| | |
|---|---|
| **Depends on** | P3-T2, P2-T1 |
| **Files** | `src/domains/agents/worker/dep-cache.ts` (new), `src/domains/agents/worker/dep-cache.test.ts` (new) |
| **Estimate** | 3–4 hrs |

**Steps:**

1. `restoreDepCache(cacheDir, workspaceDir, profile): Promise<boolean>` — copy cached dirs into workspace.
   - Phase 3 scope: **`nodejs` and `nodejs-pnpm` only** — restore `node_modules/` from `{cacheDir}/node_modules`.
   - Use `fs.cpSync` with `{ recursive: true }` or `fs.promises.cp` (Node 20+).
2. `snapshotDepCache(cacheDir, workspaceDir, profile, manifest): Promise<void>` — copy `node_modules` out after successful setup.
3. Write `manifest.json`: `{ createdAt, command, profiles, lockfileHash }`.
4. Tests: temp dirs, round-trip restore/snapshot.

**Acceptance criteria:**

- Restore returns `false` on miss; `true` on hit.
- No partial copy on failure (use temp dir + rename if needed).

---

#### P3-T4 — Integrate cache into bootstrap flow

| | |
|---|---|
| **Depends on** | P3-T3, P2-T3 |
| **Files** | `src/domains/agents/worker/workspace-bootstrap.ts`, `src/types/index.ts` |
| **Estimate** | 2 hrs |

**Steps:**

1. Before `runWorkspaceCommand`: if `depCacheEnabled`, `restoreDepCache` → set `cacheHit: true` on bootstrap state.
2. After successful command: `snapshotDepCache`.
3. Extend `AgentBootstrapState` with `cacheHit?: boolean`.
4. Log cache hit/miss.

**Acceptance criteria:**

- Second agent run on same repo+lockfile logs cache hit and faster bootstrap (manual timing optional).

---

#### P3-T5 — API: inspect and purge repo dep cache

| | |
|---|---|
| **Depends on** | P3-T3 |
| **Files** | `src/domains/repos/` (new route handler or extend existing), grep for repo API routes |
| **Estimate** | 2–3 hrs |

**Steps:**

1. `GET /api/repos/:repoId/dep-cache` — list cache entries (key, createdAt, size estimate optional).
2. `DELETE /api/repos/:repoId/dep-cache` — optional `?key=` for one entry; omit to purge all for repo.
3. Auth: same as other repo routes (API token).
4. Tests for route handlers.

**Acceptance criteria:**

- Purge forces cache miss on next run.

---

#### P3-T6 — Extend `environment.json` schema for `cacheKey`

| | |
|---|---|
| **Depends on** | P3-T2 |
| **Files** | `src/domains/agents/worker/environment-config.ts`, `docs/repo-config.md` |
| **Estimate** | 30 min |

---

#### Phase 3 — Definition of done

- [ ] `DEP_CACHE_ENABLED=true` speeds up second `npm ci` on same repo
- [ ] API purge works
- [ ] `agent.bootstrap.cacheHit` visible in API response

---

### Phase 4 — Scripts, verify, env injection

**Goal:** Support `setup.sh`, post-setup `verifyCommand`, per-repo env vars, and mode filtering.

---

#### P4-T1 — Setup script resolution and execution

| | |
|---|---|
| **Depends on** | Phase 1 complete |
| **Files** | `src/domains/agents/worker/environment-detect.ts` or `workspace-bootstrap.ts`, `src/domains/agents/worker/workspace-bootstrap.test.ts` |
| **Estimate** | 1–2 hrs |

**Steps:**

1. Constant: `.localagent-box/setup.sh`
2. Update resolution order:
   1. If `setup.sh` exists → command = `bash .localagent-box/setup.sh` (use forward slashes; Linux container)
   2. Else explicit `setup.command`
   3. Else profiles / detect
3. Log `Bootstrap: source=script`.
4. Test: temp file `setup.sh`, mock runner receives bash invocation.

**Acceptance criteria:**

- Script path takes precedence over `setup.command` in JSON.

---

#### P4-T2 — `verifyCommand` after setup

| | |
|---|---|
| **Depends on** | P1-T4 |
| **Files** | `src/domains/agents/worker/environment-config.ts`, `src/domains/agents/worker/workspace-bootstrap.ts`, `src/types/index.ts` |
| **Estimate** | 1–2 hrs |

**Steps:**

1. Add `verifyCommand?: string` to `RepoEnvironmentConfig`.
2. After successful setup, if `verifyCommand` set, run via `runWorkspaceCommand` (same timeout default or separate `verifyTimeoutMs` — optional, default same as setup).
3. Verify failure always fails bootstrap (no `failOnError` opt-out for verify).
4. Extend `AgentBootstrapState`: `verifyCommand?`, `verifyExitCode?`.
5. Tests: verify runs after setup; verify failure throws.

---

#### P4-T3 — `runOnModes` filter

| | |
|---|---|
| **Depends on** | P1-T4 |
| **Files** | `environment-config.ts`, `workspace-bootstrap.ts` |
| **Estimate** | 1 hr |

**Steps:**

1. Add `setup.runOnModes?: AgentMode[]` to config.
2. Pass `mode` from job into `runWorkspaceBootstrap`.
3. If `runOnModes` set and current mode not included → skip bootstrap (`status: 'skipped'`, log reason).
4. Test: batch-only setup skipped for `review` mode.

---

#### P4-T4 — Inject repo `env` into setup and OpenCode session

| | |
|---|---|
| **Depends on** | P1-T2, P1-T4 |
| **Files** | `src/domains/agents/worker/environment-config.ts`, `src/domains/agents/worker/workspace-bootstrap.ts`, `src/integrations/opencode/session-runner.ts` |
| **Estimate** | 2–3 hrs |

**Steps:**

1. Add `env?: Record<string, string>` to `RepoEnvironmentConfig` — validate: string keys/values only, max 32 keys, key length limits.
2. Merge `config.env` into `runWorkspaceCommand` env: `{ ...process.env, ...config.env }`.
3. Persist resolved env on agent dir: `{dataDir}/agents/{agentId}/bootstrap-env.json` (optional) for debugging.
4. Pass env into OpenCode spawn: extend `buildIsolationEnv` or session runner `env` merge so agent tools see `NODE_ENV`, `CI`, etc.
5. Do not log env values matching `/secret|token|key/i` in keys.

**Acceptance criteria:**

- Setup command sees `env` vars.
- OpenCode bash tool inherits them in same agent run.

---

#### P4-T5 — Inject bootstrap summary into agent prompt

| | |
|---|---|
| **Depends on** | P4-T2 |
| **Files** | `src/integrations/opencode/runner.ts` or mode run flows, `workspace-bootstrap.ts` |
| **Estimate** | 1–2 hrs |

**Steps:**

1. Return bootstrap summary string from `runWorkspaceBootstrap` (or read from agent record).
2. Prepend to first prompt body:

```
## Workspace ready (host)
- Setup: completed in 38s
- Profiles: nodejs-pnpm
- Verify: passed (`npm test`)
```

3. Only when bootstrap `status === 'completed'`.

---

#### P4-T6 — Update docs and `AGENTS.md` guidance

| | |
|---|---|
| **Depends on** | P4-T1–P4-T5 |
| **Files** | `docs/repo-config.md`, `AGENTS.md` |
| **Estimate** | 30 min |

---

#### Phase 4 — Definition of done

- [ ] `setup.sh` works
- [ ] `verifyCommand` fails agent when tests fail
- [ ] `runOnModes` respected
- [ ] Env vars visible in setup shell

---

### Phase 5 — Operator ergonomics

**Goal:** Tooling and workflows for cache warming, scaffolding, and custom images. Tasks are largely independent.

---

#### P5-T1 — CLI: scaffold `environment.json`

| | |
|---|---|
| **Depends on** | Phase 2 complete |
| **Files** | `src/cli/init-env.ts` (new), `package.json` script `init-env` |
| **Estimate** | 2–3 hrs |

**Steps:**

1. `npm run init-env -- [--path=.]`: scan directory for lockfiles, print or write `.localagent-box/environment.json` with detected profiles and suggested `setup.command`.
2. `--dry-run` prints JSON to stdout only.
3. No server required; runs locally for repo maintainers.

---

#### P5-T2 — Bootstrap dry-run mode

| | |
|---|---|
| **Depends on** | P2-T3 |
| **Files** | `workspace-bootstrap.ts`, `src/config/env.ts` |
| **Estimate** | 1 hr |

**Steps:**

1. Env `BOOTSTRAP_DRY_RUN=true`: log resolved command, profiles, cache key, but do not execute shell.
2. Return `{ status: 'completed', command, ... }` with `dryRun: true` flag on state.

---

#### P5-T3 — Cache-warm job on repo registration

| | |
|---|---|
| **Depends on** | Phase 3 complete |
| **Files** | `src/domains/repos/repo.service.ts`, `src/domains/agents/agent.service.ts` |
| **Estimate** | 3–4 hrs |

**Steps:**

1. Server config flag: `warmDepCacheOnRepoAdd?: boolean`.
2. On `POST /api/repos` success, enqueue lightweight job: clone default branch → bootstrap only → exit (no OpenCode).
3. New agent `mode` value `bootstrap` **or** internal worker flag `bootstrapOnly: true` on job (prefer flag to avoid UI exposure).
4. Reuse `prepareWorkspace` + `runWorkspaceBootstrap`; skip run flows in `agent-worker.ts` when flag set.

---

#### P5-T4 — Bootstrap duration metrics

| | |
|---|---|
| **Depends on** | P1-T5 |
| **Files** | `src/domains/agents/agent.service.ts`, optional metrics endpoint |
| **Estimate** | 1–2 hrs |

**Steps:**

1. When listing agents for a repo, expose rolling median `bootstrap.durationMs` (last N completed agents).
2. UI: show "Typical bootstrap: ~45s" on create-agent form (optional).

---

#### P5-T5 — Custom image documentation

| | |
|---|---|
| **Depends on** | P2-T5 |
| **Files** | `docs/docker-hosting.md` (new section) |
| **Estimate** | 30 min |

**Document:** `FROM localagent-box`, adding apt packages, pinning Node/Python, org CA certs, private registry `.npmrc` in image.

---

#### P5-T6 — Security hardening pass

| | |
|---|---|
| **Depends on** | Phase 4 complete |
| **Files** | `environment-config.ts`, `workspace-bootstrap.ts` |
| **Estimate** | 1–2 hrs |

**Steps:**

1. Reject setup commands containing `sudo`, `su -`, `chmod +s` (warn or throw at validation).
2. Redact env values in logs when key matches `/secret|token|password|key/i`.
3. Cap `setup.command` length (e.g. 8 KB).

---

#### Phase 5 — Definition of done

- [ ] `init-env` generates valid config for this repo
- [ ] Cache-warm job populates dep cache without full agent run
- [ ] Docs cover custom images

---

### Task index (quick reference)

| ID | Title | Phase |
|----|-------|-------|
| P1-T1 | Types for environment config | 1 |
| P1-T2 | Shared workspace command runner | 1 |
| P1-T3 | Environment config loader | 1 |
| P1-T4 | Bootstrap orchestrator | 1 |
| P1-T5 | Wire into prepareWorkspace | 1 |
| P1-T6 | Document environment.json | 1 |
| P2-T1 | Runtime profile catalog | 2 |
| P2-T2 | Lockfile auto-detection | 2 |
| P2-T3 | Integrate resolver into bootstrap | 2 |
| P2-T4 | Server config profile gate | 2 |
| P2-T5 | Dockerfile corepack | 2 |
| P2-T6 | UI bootstrap display | 2 |
| P2-T7 | Docs profiles/auto-detect | 2 |
| P3-T1 | Dep cache env/paths | 3 |
| P3-T2 | Cache key computation | 3 |
| P3-T3 | Cache restore/snapshot | 3 |
| P3-T4 | Integrate cache into bootstrap | 3 |
| P3-T5 | Dep cache API | 3 |
| P3-T6 | cacheKey in schema | 3 |
| P4-T1 | setup.sh execution | 4 |
| P4-T2 | verifyCommand | 4 |
| P4-T3 | runOnModes filter | 4 |
| P4-T4 | env injection | 4 |
| P4-T5 | Bootstrap prompt injection | 4 |
| P4-T6 | Docs + AGENTS.md | 4 |
| P5-T1 | init-env CLI | 5 |
| P5-T2 | Dry-run mode | 5 |
| P5-T3 | Cache-warm on repo add | 5 |
| P5-T4 | Bootstrap metrics | 5 |
| P5-T5 | Custom image docs | 5 |
| P5-T6 | Security hardening | 5 |

---

## Config Authoring Guide (for repo maintainers)

### Minimal Node repo

```json
// .localagent-box/environment.json
{
  "version": 1,
  "profiles": ["nodejs"],
  "setup": { "command": "npm ci" },
  "verifyCommand": "npm test -- --passWithNoTests"
}
```

### Monorepo with pnpm

```json
{
  "version": 1,
  "profiles": ["nodejs-pnpm"],
  "setup": { "command": "pnpm install --frozen-lockfile" },
  "cacheKey": "acme-monorepo-pnpm9",
  "env": { "NODE_OPTIONS": "--max-old-space-size=4096" }
}
```

### Python with venv

```json
{
  "version": 1,
  "profiles": ["python"],
  "setup": {
    "command": "python3 -m venv .venv && . .venv/bin/activate && pip install -e '.[dev]'"
  },
  "verifyCommand": ". .venv/bin/activate && pytest --co -q"
}
```

### Complex: use setup script

Commit `.localagent-box/setup.sh` (executable) and omit `setup.command`. The host runs the script with `bash`.

**Note:** `.localagent-box/` is gitignored in agent clones for agent-written artifacts (`loop-plan.md`, etc.). Setup config files (`environment.json`, `setup.sh`) must be **committed in the source repo** and read by the host immediately after clone, before the ignore rule affects agent commits.

---

## Process Improvements Beyond Bootstrap

### 1. Warm cache on repo registration

When a repo is added via the UI/API, optionally enqueue a **cache-warm job** that clones + bootstraps without running an agent. First real agent start is then fast.

### 2. Bootstrap status in agent queue

Show queue position + estimated bootstrap time based on historical `bootstrap.durationMs` per repo.

### 3. Fail-fast with actionable errors

If bootstrap fails, set agent status `failed` with:

```
Bootstrap failed: `npm ci` exited 1
npm ERR! Missing script: "prepare"
```

Don't start OpenCode — saves tokens and gives clearer UX than agent discovering a broken env.

### 4. Inject bootstrap context into agent prompt

After successful bootstrap, prepend a short host-generated block:

```
## Workspace ready
- Profiles: nodejs-pnpm
- Setup: completed in 38s (cache hit)
- Verify: `npm test` passed
- Use: pnpm run build, pnpm test
```

Reduces agent time spent discovering how to run checks.

### 5. Align with `AGENTS.md`

Add a section to the default `AGENTS.md` template:

> Dependencies are pre-installed by the host. Do not run `npm install` unless you changed `package.json`. Use `npm test` / `npm run build` to verify.

### 6. Security constraints

- Setup commands run in the **host worker process** (same trust boundary as `checkCommand`)
- No network allowlist in v1 — document that repos are trusted (private GitHub App scope)
- Cap timeout (default 10 min, max 30 min)
- Reject `sudo` / root escalation patterns in validation (warn or block)
- Never log env vars that match `*TOKEN*`, `*SECRET*`, `*KEY*`

### 7. Windows dev vs Linux production

Workers run Linux in Docker. `environment.json` commands should target Linux. For local Windows dev of localagent-box itself, the shared shell runner already handles `cmd.exe` — but repo setup commands should be documented as bash for production.

---

## Tradeoffs

| Decision | Pros | Cons |
|----------|------|------|
| **Run setup every run (no cache)** | Simple, always correct | Slow; 2–5 min per Node monorepo |
| **Dep cache volume** | Fast repeat runs | Stale cache risk; disk usage |
| **Auto-detect only** | Zero config for standard repos | Wrong guess on unusual layouts |
| **Explicit config only** | Predictable | Requires repo maintainer effort |
| **Fail on bootstrap error** | Clean failures | Stricter; some repos may need `failOnError: false` |
| **Bake deps in custom image** | Fastest | Per-repo images don't scale; use cache instead |

**Recommendation:** Phase 1 with explicit `setup.command` + Phase 3 caching + conservative auto-detect (log and allow override). This gives immediate value without magic.

---

## Files to Touch (implementation reference)

| File | Change |
|------|--------|
| `src/domains/agents/worker/workspace-setup.ts` | Call bootstrap after clone |
| `src/domains/agents/worker/workspace-bootstrap.ts` | **New** — orchestration |
| `src/domains/agents/worker/environment-config.ts` | **New** — schema + loader |
| `src/domains/agents/worker/workspace-command.ts` | **New** — shared shell runner (extract from loop-check) |
| `src/domains/agents/worker/dep-cache.ts` | **New** — cache restore/snapshot (Phase 3) |
| `src/types/index.ts` | `RepoEnvironmentConfig`, `BootstrapResult` types |
| `config/runtime-profiles.json` | **New** — app-wide profile catalog |
| `Dockerfile` | Optional runtimes (corepack, go, etc.) |
| `docker-compose.yml` | `DEP_CACHE_ROOT`, volume already covers `/data` |
| `docs/repo-config.md` | Document `environment.json` |
| `docs/agent-bootstrap.plan.md` | This plan |

---

## Success Metrics

- **Time to first tool call:** median seconds from agent create → first OpenCode `tool.start`
- **Bootstrap duration:** p50/p95 per repo, cache hit rate
- **Zero-change batch failures due to missing deps:** should drop after bootstrap + verify
- **Agent token savings:** fewer install/discovery turns in batch runs

---

## Summary

The natural extension point is `prepareWorkspace()` — the same place `codegraph init` already runs. Repos declare needs via `.localagent-box/environment.json` (and optionally `setup.sh`). The server provides app-wide runtime profiles and, critically, a **persistent dependency cache** so repeat agent runs don't pay full install cost on every fresh clone.

Phase 1 (explicit `setup.command` + logging + fail-fast) is small, high-value, and reuses the `checkCommand` execution model. Caching and auto-detect follow once the bootstrap hook is in place.
