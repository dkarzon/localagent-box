# Local Agent Box

A self-hosted daemon for running autonomous coding agents (powered by [OpenCode](https://opencode.ai)) against your own GitHub repositories and your own LLM (local via Ollama, or any OpenCode-compatible provider).
> Spin up, check out, push code - entirely on infrastructure you control.

## What this is (and isn't)

- **Is:** a small API + UI you self-host (Docker or bare Node) that clones a repo, runs an OpenCode agent against a prompt, and commits/pushes the result — with batch, interactive, and config-driven loop modes.
- **Is:** designed for a **trusted local network** (home LAN, VPN, single-tenant internal network) — see [SECURITY.md](./SECURITY.md) before exposing it more broadly.
- **Isn't:** a multi-tenant SaaS, a sandboxed execution environment, or a hardened public-internet service out of the box. Agents run with full filesystem access to their workspace and no network isolation.
- **Isn't:** affiliated with, or a redistribution of, any third-party hosted "cloud agent" product — it's an independent, self-hosted alternative built on OpenCode.

![Agent Session Page](https://raw.githubusercontent.com/dkarzon/localagent-box/refs/heads/main/docs/AgentSessionPage.png)

## Architecture

```
   HTTP API + UI (Node/Express, React)
            │
            ▼
     Agent scheduler (main process)
            │  spawns one child process per running agent
            ▼
   Worker (opencode serve + harness)  ──git──▶  GitHub (via GitHub App)
            │
            ▼
   Ephemeral workspace clone (AGENT_WORKSPACE)
```

- A single Node process serves the REST/SSE API and the built UI, and persists state (`config.json`, `repos.json`, `agents.json`) as JSON files under `DATA_DIR`.
- Each agent run is a separate child process (`src/workers/agent-worker.ts`) that shallow-clones the target repo into its own workspace, starts a per-agent `opencode serve` instance (batch, interactive, and loop modes), or runs [Open Code Review](https://alibaba.github.io/open-code-review/#/docs) (`review` mode), and drives it through one of four flows: **batch** (single prompt → commit/push), **interactive** (multi-turn, explicit Finish), **loop** (config-driven orient/act/reflect harness, see `config/loop.default.json`), or **review** (branch-range PR review via OCR → optional GitHub PR comments).
- GitHub access goes through a **GitHub App** installation token minted per-request (`src/services/github-app.ts`) — no long-lived PAT or SSH key is stored.
- Agent state, logs, and events stream back to the API over the child process's stdout/IPC and are exposed to the UI via Server-Sent Events.

There is no per-agent sandboxing (container, chroot, network namespace) — see [SECURITY.md](./SECURITY.md) for what that means for your deployment.

## Quick start

### Prebuilt image (recommended)

Pull the published image from GitHub Container Registry:

```bash
docker pull ghcr.io/dkarzon/localagent-box:latest
```

Full run instructions, Compose example, and **required environment variables** (`API_TOKEN`, `NODE_ENV`, `OLLAMA_BASE_URL`, volumes): [docs/docker-hosting.md](./docs/docker-hosting.md).

Minimal example:

```bash
docker volume create localagent-data
docker volume create localagent-workspace
docker run -d --name localagent-box --restart unless-stopped -p 8080:8080 \
  -e NODE_ENV=production -e API_TOKEN=your-secret-token \
  -e OLLAMA_BASE_URL=http://host.docker.internal:11434 \
  --add-host=host.docker.internal:host-gateway \
  -v localagent-data:/data -v localagent-workspace:/workspace \
  ghcr.io/dkarzon/localagent-box:latest
```

### Build from source

```bash
docker compose up -d --build
```

Open the management UI at [http://localhost:8080](http://localhost:8080). The default API token is `localagent-box` (pre-filled in the UI) — this is fine for a quick local trial, but **set a strong `API_TOKEN`** (and read [SECURITY.md](./SECURITY.md)) before running this anywhere reachable by anyone you don't trust.

Next steps: [set up a GitHub App](./docs/github-app-setup.md) so agents can clone, commit, and open PRs against your repos.

## Local development

The repo has two parts: a **TypeScript Node.js API** in `src/` (compiled to `dist/`) and a **React + Vite UI** in `client/`. In production and Docker, the API serves the built UI from `public/`.

### Prerequisites

- **Node.js** ≥ 20
- **Git** (clone/verify/push)
- **Ollama** — optional for health checks; required to run agents against a local model
- **OpenCode CLI** — `npm install -g opencode-ai@v1.18.18` (matches the version pinned in the Dockerfile; needed when starting agent jobs locally)

### Install dependencies

From the repo root:

```bash
npm install --ignore-scripts
npm install --prefix client
```

Use `--ignore-scripts` on the root install if the `postinstall` hook loops on your machine; then install the client explicitly as shown.

### Run locally

Build the UI and API, then serve everything from one process:

```bash
# Windows (PowerShell)
$env:DATA_DIR="./data"; npm run build:ui && npm run build && npm start

# macOS / Linux
DATA_DIR=./data npm run build:ui && npm run build && npm start
```

Open [http://localhost:8080](http://localhost:8080).

Persisted state (config, repos, agents) is written under `./data/` when `DATA_DIR=./data` is set. Agent git workspaces use `./data/workspace/agents/` on Windows.

For API-only work with auto-restart on change, use `npm run dev` instead of `npm start` (after building the UI once).

### Local Docker build and run

To use the **prebuilt GHCR image** instead of building locally, see [docs/docker-hosting.md](./docs/docker-hosting.md).

Run once to create the volumes (shared across docker sessions):
```bash
docker build --tag 'localagent-box' .
```

Build and run the docker image.

```bash
docker volume create localagent-data
docker run -it --rm -p 8080:8080 -v localagent-data:/data 'localagent-box'
```

### Useful local environment variables

| Variable | Default (local) | Purpose |
|----------|-----------------|---------|
| `PORT` | `8080` | HTTP listen port |
| `DATA_DIR` | `/data` | Config and agent state directory (use `./data` locally) |
| `API_TOKEN` | `localagent-box` | Bearer token for mutating API calls |
| `OLLAMA_BASE_URL` | — | Bootstrap Ollama URL on first start (e.g. `http://localhost:11434`) |
| `AGENT_WORKSPACE` | platform-specific | Directory for ephemeral agent clones |
| `MAX_CONCURRENT_AGENTS` | `3` | Concurrent agent workers |
| `AGENT_TIMEOUT` | `3600` | Batch worker timeout in seconds, measured from when the worker starts running (not queue wait) |
| `OCR_REVIEW_TIMEOUT` | `30` | Per-file OCR review deadline in minutes (`0` disables). OCR's own default is 10. |
| `OCR_LLM_TIMEOUT` | `600` | Per-request OCR LLM HTTP timeout in seconds. OCR's own default is 300. |
| `OCR_REVIEW_CONCURRENCY` | `8` | Max file groups reviewed in parallel. Lower for local LLMs (e.g. Ollama). |
| `OPENCODE_BIN` | `opencode` | OpenCode CLI binary |
| `OPENCODE_PORT_BASE` | `4100` | Base port for per-agent `opencode serve` |
| `OPENCODE_STARTUP_TIMEOUT_MS` | `900000` | Max wait for `opencode serve` to become ready |

### Scripts reference

| Command | Description |
|---------|-------------|
| `npm run dev` | Run API from TypeScript with `tsx watch` |
| `npm run dev:ui` | Vite dev server for the React UI |
| `npm run build` | Compile `src/` → `dist/` |
| `npm run build:ui` | Build UI into `public/` |
| `npm start` | Run compiled API (`dist/server.js`) |

## GitHub App setup

Agents authenticate to GitHub as an installed **GitHub App** (no PAT or SSH key). See [docs/github-app-setup.md](./docs/github-app-setup.md) for step-by-step instructions: creating the app, scoping permissions (Contents + Pull requests, read/write), installing it on your repos, generating a private key, and wiring the resulting `githubAppId` / `githubAppInstallationId` / `githubAppPrivateKey` into Settings.

## Security

localagent-box is built for a **trusted local network**, not the open internet. Highlights (full detail in [SECURITY.md](./SECURITY.md)):

- Mutating endpoints require a Bearer token; most `GET` endpoints (config, agent logs/transcripts/events, repo metadata) are **intentionally unauthenticated** so the UI and SSE streams work without embedding a token in every request.
- The default `API_TOKEN` (`localagent-box`) is meant for local trials only — always override it before exposing the service beyond your own machine, and set `NODE_ENV=production` so the server refuses to boot with the default token.
- Agents run as plain child processes with full access to their workspace and the host's network — there is no per-agent sandbox.
- If you must reach this from outside a trusted LAN/VPN, put it behind a reverse proxy with its own TLS + auth; never port-forward it directly.

Read [SECURITY.md](./SECURITY.md) before deploying anywhere beyond a local trial.

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|---------------------|
| `401 Unauthorized` on `POST`/`PUT`/`DELETE` calls | Missing or wrong `Authorization: Bearer <API_TOKEN>` header; check the token in Settings or your `API_TOKEN` env var |
| Server refuses to start in Docker/production | `NODE_ENV=production` with the default `API_TOKEN` (`localagent-box`) still set — pick a real token |
| Health check shows Ollama as unreachable | `ollamaBaseUrl` isn't reachable from inside the container — on Docker Desktop use `http://host.docker.internal:11434`, not `localhost` |
| Agent fails immediately with a GitHub/clone error | GitHub App isn't installed on that repo, or `githubAppId`/`githubAppInstallationId`/`githubAppPrivateKey` are wrong — see [docs/github-app-setup.md](./docs/github-app-setup.md#troubleshooting) |
| Agent finishes but no PR appears | `push` was `false`, or the OpenCode run didn't produce a commit — batch/loop runs fail if nothing was committed; check `GET /agents/:id/logs` |
| Review agent fails immediately | Ollama not configured or unreachable — OCR requires `ollamaBaseUrl`; check Settings and [docs/code-review.md](./docs/code-review.md) |
| Review completes but nothing on GitHub | No PR exists for `headBranch`, or GitHub App lacks pull request write — check logs for "No matching PR" or GitHub warnings |
| `npm install` hangs or loops | Use `npm install --ignore-scripts` at the repo root, then `npm install --prefix client` separately (see [Install dependencies](#install-dependencies)) |

For anything else, check `GET /agents/:id/logs` and `GET /agents/:id/events` for the failing session, and [SECURITY.md](./SECURITY.md) if the question is auth/network-related.

## API v1

Base URL: `http://localhost:8080`

Mutating requests require `Authorization: Bearer <API_TOKEN>`. Default token: `localagent-box`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | No | Liveness check + Ollama connectivity probe |
| `GET` | `/api/v1/config` | No | Current settings (secrets redacted) |
| `PUT` | `/api/v1/config` | Yes | Update settings and write OpenCode config |
| `GET` | `/api/v1/github/status` | No | GitHub App credential summary (no secrets) |
| `POST` | `/api/v1/github/verify` | Yes | Test shallow clone of `{ owner, name, branch? }` |
| `GET` | `/api/v1/repos` | No | List registered repos |
| `POST` | `/api/v1/repos` | Yes | Register repo `{ owner, name, defaultBranch }` |
| `GET` | `/api/v1/repos/:repoId` | No | Get registered repo metadata |
| `DELETE` | `/api/v1/repos/:repoId` | Yes | Remove registered repo |
| `PUT` | `/api/v1/repos/:repoId` | Yes | Update repo settings (`autoReviewPullRequests`: `true`, `false`, or `null` to inherit) |
| `POST` | `/api/v1/repos/:repoId/verify` | Yes | Test shallow clone for registered repo |
| `GET` | `/api/v1/agents` | No | List agents (`?repoId=`, `?status=` filters) |
| `POST` | `/api/v1/agents` | Yes | Start repo-scoped agent |
| `GET` | `/api/v1/agents/:agentId` | No | Agent status |
| `GET` | `/api/v1/agents/:agentId/logs` | No | Agent log tail (`?tail=200`, default 200) |
| `GET` | `/api/v1/agents/:agentId/events` | No | SSE stream of agent events (`?since=` or `Last-Event-ID`) |
| `GET` | `/api/v1/agents/:agentId/messages` | No | Transcript + events snapshot (`?since=` for event replay) |
| `POST` | `/api/v1/agents/:agentId/messages` | Yes | Send follow-up message (interactive only) |
| `POST` | `/api/v1/agents/:agentId/finish` | Yes | Finish interactive or loop session + commit/push |
| `POST` | `/api/v1/agents/:agentId/retry` | Yes | Re-queue a failed or cancelled session in the same slot |
| `POST` | `/api/v1/agents/:agentId/allow-successors` | Yes | Let later sessions on the same branch start after a failed/cancelled chunk |
| `POST` | `/api/v1/agents/:agentId/pull-request` | Yes | Open GitHub PR for completed, pushed session |
| `GET` | `/api/v1/agents/:agentId/pull-request` | No | Refresh linked PR state from GitHub |
| `POST` | `/api/v1/agents/:agentId/delete` | Yes | Remove agent record, logs, and workspace |
| `DELETE` | `/api/v1/agents/:agentId` | Yes | Cancel a running or queued agent |

### Config fields

| Field | Description |
|-------|-------------|
| `ollamaBaseUrl` | External self-hosted Ollama URL |
| `opencodeModel` | Model name on Ollama |
| `opencodeProvider` | Provider id (default `ollama`) |
| `systemPrompt` | Default system prompt for agents (empty string stored as `null` in GET) |
| `githubAppId` | GitHub App ID |
| `githubAppInstallationId` | Installation ID |
| `githubAppPrivateKey` | PEM private key *(sent as `***` in GET; omit or send `***` on PUT to keep existing key)* |
| `gitUserName` | Commit author name |
| `gitUserEmail` | Commit author email |
| `webhookUrl` | Optional HTTP(S) URL; POST JSON on terminal agent status (`agent.completed`, `agent.failed`, `agent.cancelled`) |
| `batchAutoApprovePermissions` | When true (default), batch agents auto-approve OpenCode tool permissions via per-agent `opencode.json` |
| `loopAutoApprovePermissions` | When true (default), loop agents auto-approve tool permissions |
| `interactiveAutoApprovePermissions` | When true, interactive agents auto-approve tool permissions (default false) |
| `interactiveAgentTimeoutSeconds` | Interactive session timeout in seconds from worker start (default `3600`; separate from `AGENT_TIMEOUT` for batch workers) |
| `loopAgentTimeoutSeconds` | Loop session timeout in seconds from worker start (default `3600`; separate from `AGENT_TIMEOUT` for batch workers) |
| `loopVerbModels` | Per-verb model overrides for loop mode (`INITIAL_PLAN`, `ORIENT`, `ACT`, `REFLECT`). Empty string on a verb uses the fallback chain below. Legacy `OBSERVE`/`PLAN` keys are accepted and folded into `ORIENT`. |
| `autoCreatePullRequest` | When true (default), automatically open a draft PR once an agent completes and pushes its branch. A per-agent `autoCreatePullRequest` on create overrides this. |
| `autoReviewPullRequests` | When true, auto-queue a review agent after a coding agent's PR is created (default false). Per-repo `autoReviewPullRequests` overrides this global default. See [docs/code-review.md](./docs/code-review.md). |
| `reviewModel` | Model used for auto-queued and manual review agents (Open Code Review); falls back to `opencodeModel` when empty |

All fields above are readable via `GET /api/v1/config` and settable via `PUT /api/v1/config`, and every one of them is editable from the **Settings** page in the UI (API Access, Ollama Status, GitHub Integration, Webhooks, OpenCode, Pull requests & review, and OpenCode permissions cards). Batch, loop, and interactive agents all run through `opencode serve` with per-agent isolated config at `{dataDir}/agents/{agentId}/opencode-config/opencode.json`. Per-agent `autoApprovePermissions` on create overrides the mode default from Settings.

#### Loop verb model resolution

When a loop step runs, the model is chosen in this order:

1. **`loopVerbModels[verb]`** — Settings value for that step (e.g. `ACT`), when non-empty
2. **`model` on agent create** — per-agent override from the create form
3. **`opencodeModel`** — global default from Settings
4. **OpenCode default** — when nothing above is set

Step **prompts** stay in `config/loop.default.json` or repo `.localagent-box/loop.json`; verb models are a server-wide operator setting (same pattern as `loopAutoApprovePermissions`).

Example — global default `llama3.2`, ACT on a coder model, others blank:

```json
{
  "opencodeModel": "llama3.2",
  "loopVerbModels": {
    "INITIAL_PLAN": "",
    "ORIENT": "",
    "ACT": "qwen3-coder:30b",
    "REFLECT": ""
  }
}
```

ORIENT, REFLECT, and INITIAL_PLAN use `llama3.2`; ACT uses `qwen3-coder:30b`.

### Examples

```bash
curl http://localhost:8080/health

curl http://localhost:8080/api/v1/config

curl -X PUT http://localhost:8080/api/v1/config \
  -H "Authorization: Bearer localagent-box" \
  -H "Content-Type: application/json" \
  -d '{"ollamaBaseUrl":"http://host.docker.internal:11434","opencodeModel":"llama3.2"}'
```

Saving Ollama settings writes OpenCode config to `~/.config/opencode/opencode.json` inside the container. The health endpoint probes `{ollamaBaseUrl}/api/tags`.

Optional bootstrap env vars: `OLLAMA_BASE_URL`, `OPENCODE_MODEL`, `OPENCODE_PROVIDER`.

### GitHub App verify

```bash
curl http://localhost:8080/api/v1/github/status

curl -X POST http://localhost:8080/api/v1/github/verify \
  -H "Authorization: Bearer localagent-box" \
  -H "Content-Type: application/json" \
  -d '{"owner":"your-org","name":"your-private-repo","branch":"main"}'
```

Installation tokens are minted server-side and never returned by the API. Clone URLs with embedded tokens are redacted from error messages.

### Repo registration

```bash
curl http://localhost:8080/api/v1/repos

curl -X POST http://localhost:8080/api/v1/repos \
  -H "Authorization: Bearer localagent-box" \
  -H "Content-Type: application/json" \
  -d '{"owner":"your-org","name":"your-repo","defaultBranch":"main"}'

curl -X POST http://localhost:8080/api/v1/repos/your-org-your-repo/verify \
  -H "Authorization: Bearer localagent-box" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Repo metadata is persisted in `DATA_DIR/repos.json`. Clones happen in ephemeral workspaces at verify/agent time, not at registration.

### Agents

Agents support four modes:

| Mode | Behavior |
|------|----------|
| **`batch`** (default) | Single prompt → `opencode serve` (session orchestrator) → auto commit/push → terminal status. Best for API, CI, and one-shot UI runs. |
| **`interactive`** | Multi-turn session on the same OpenCode server. Follow-up messages when `status` is `awaiting_input`; call **Finish** to commit/push. |
| **`loop`** | Config-driven harness: observe → plan → act → reflect cycles until the model emits `LOOP_COMPLETE: true` on REFLECT or host caps are hit. Create-time `prompt` is the **goal**; step prompts come from `loop.json`. Optional per-verb models in Settings (`loopVerbModels`). Single commit/push at end (or early **Finish**). |
| **`review`** | Branch-range PR review via [Open Code Review](https://alibaba.github.io/open-code-review/#/docs) (`ocr review`). Clones and checks out `headBranch`, diffs against `baseBranch`, posts findings to GitHub when a matching PR exists. No OpenCode session; no commit/push. See [docs/code-review.md](./docs/code-review.md). |

Omit `mode` or set `"mode": "batch"` for the existing headless behavior.

```bash
curl http://localhost:8080/api/v1/agents
curl "http://localhost:8080/api/v1/agents?repoId=your-org-your-repo&status=running"

# Batch (default)
curl -X POST http://localhost:8080/api/v1/agents \
  -H "Authorization: Bearer localagent-box" \
  -H "Content-Type: application/json" \
  -d '{
    "repoId": "your-org-your-repo",
    "prompt": "Add input validation to the login form",
    "systemPrompt": "You are a careful code reviewer.",
    "baseBranch": "main",
    "agentBranch": "agent/task-42",
    "commitMessage": "Agent: add login validation",
    "push": true,
    "model": "llama3.2"
  }'

# Interactive — multi-turn session
curl -X POST http://localhost:8080/api/v1/agents \
  -H "Authorization: Bearer localagent-box" \
  -H "Content-Type: application/json" \
  -d '{
    "repoId": "your-org-your-repo",
    "mode": "interactive",
    "prompt": "Explore the auth module and suggest fixes",
    "baseBranch": "main",
    "agentBranch": "agent/interactive-1",
    "autoApprovePermissions": false,
    "push": true
  }'

# Loop — config-driven harness toward a goal
curl -X POST http://localhost:8080/api/v1/agents \
  -H "Authorization: Bearer localagent-box" \
  -H "Content-Type: application/json" \
  -d '{
    "repoId": "your-org-your-repo",
    "mode": "loop",
    "prompt": "Add input validation to the login form with tests",
    "baseBranch": "main",
    "agentBranch": "agent/loop-validation",
    "push": true
  }'

# Review — Open Code Review on a branch range (posts to GitHub PR when one exists)
curl -X POST http://localhost:8080/api/v1/agents \
  -H "Authorization: Bearer localagent-box" \
  -H "Content-Type: application/json" \
  -d '{
    "repoId": "your-org-your-repo",
    "mode": "review",
    "baseBranch": "main",
    "headBranch": "agent/task-42",
    "background": "Focus on security and edge cases."
  }'

curl http://localhost:8080/api/v1/agents/<agentId>

curl "http://localhost:8080/api/v1/agents/<agentId>/logs?tail=100"

# SSE + transcript (both modes; replay with ?since=<seq>)
curl -N "http://localhost:8080/api/v1/agents/<agentId>/events?since=0"
curl "http://localhost:8080/api/v1/agents/<agentId>/messages?since=0"

# Interactive only (409 NOT_INTERACTIVE on batch and loop)
curl -X POST http://localhost:8080/api/v1/agents/<agentId>/messages \
  -H "Authorization: Bearer localagent-box" \
  -H "Content-Type: application/json" \
  -d '{"text":"Also add tests for the login form"}'

# Interactive or loop — early finish + commit/push
curl -X POST http://localhost:8080/api/v1/agents/<agentId>/finish \
  -H "Authorization: Bearer localagent-box"

# GitHub PR after successful batch finish or interactive Finish (requires push)
curl -X POST http://localhost:8080/api/v1/agents/<agentId>/pull-request \
  -H "Authorization: Bearer localagent-box" \
  -H "Content-Type: application/json" \
  -d '{"title":"Agent: add login validation","body":"Optional PR body"}'
curl http://localhost:8080/api/v1/agents/<agentId>/pull-request

curl -X DELETE http://localhost:8080/api/v1/agents/<agentId> \
  -H "Authorization: Bearer localagent-box"

curl -X POST http://localhost:8080/api/v1/agents/<agentId>/delete \
  -H "Authorization: Bearer localagent-box"
```

Each agent gets an isolated git workspace under `AGENT_WORKSPACE` (default `{DATA_DIR}/workspace/agents/<workspaceId>/` on Windows, `/workspace/agents/<workspaceId>/` in Docker). Agent metadata, logs, events, and per-agent OpenCode config live under `{DATA_DIR}/agents/{agentId}/`. Batch, interactive, and loop modes use `opencode serve` with the session orchestrator; interactive workers poll an inbox for follow-ups until Finish; loop workers drive multi-step harness cycles from config; **review** workers run Open Code Review instead of OpenCode. Multiple sessions may share an `agentBranch`; at most one worker runs per `(repoId, agentBranch)` and a later session starts only after the previous one on that branch completed and pushed.

#### Loop harness config (`loop.json`)

Loop mode uses a server default at `config/loop.default.json`. A repo can fully replace it with `.localagent-box/loop.json` in the cloned workspace (no partial merge in v1).

```json
{
  "version": 1,
  "maxIterations": 10,
  "completionMarker": "LOOP_COMPLETE",
  "initialPlanPrompt": "Create a high-level plan for the goal before iterative cycles begin.\n\nGoal: {{goal}}",
  "steps": [
    { "verb": "ORIENT", "prompt": "Inspect the relevant code and state the smallest next change…\n\nGoal: {{goal}}\nIteration: {{iteration}}" },
    { "verb": "ACT", "prompt": "Implement the change…\n\nGoal: {{goal}}\nIteration: {{iteration}}" },
    { "verb": "REFLECT", "prompt": "If done, output: {{completionMarker}}: true\n\nGoal: {{goal}}\nIteration: {{iteration}}" }
  ]
}
```

Valid step verbs are `ORIENT`, `ACT`, and `REFLECT` (legacy `OBSERVE`/`PLAN` are accepted and normalized to `ORIENT`). Template variables: `{{goal}}` (create-time prompt), `{{iteration}}` (1-based macro-iteration; `0` during optional `initialPlanPrompt`), `{{completionMarker}}`. Optional `initialPlanPrompt` runs once before the first iteration to produce a high-level plan for the goal. The model must emit a line matching `LOOP_COMPLETE: true` (or your custom marker) on REFLECT to signal completion. Loop runs fail if no file changes are committed at end (same as batch).

### Create-agent body

| Field | Description |
|-------|-------------|
| `repoId` | Registered repo id (required) |
| `prompt` | User task prompt (required); for loop mode this is the **goal** |
| `agentBranch` | Branch to create and work on (optional; defaults to `localagent-{sessionId}` using the new agent id). Ignored when `useExistingBranch` is true. |
| `useExistingBranch` | When `true`, shallow-clone and check out `baseBranch` on the remote instead of creating a new `agentBranch` (default `false`) |
| `mode` | `batch` (default), `interactive`, `loop`, or `review` |
| `baseBranch` | Base to clone (default: repo `defaultBranch` or `main`); for `review`, the diff **from** branch |
| `headBranch` | Review mode only — branch to check out and review (diff **to** branch); required for `review` |
| `background` | Review mode only — optional context passed to Open Code Review |
| `parentAgentId` | Review mode only — link to a parent coding session (auto-spawn sets this) |
| `systemPrompt` | Optional per-agent system prompt |
| `commitMessage` | Git commit message (default `Agent: <agentBranch>`; used on Finish for interactive) |
| `push` | Push branch after commit (default `true`) |
| `pushOnFailure` | Commit/push even when OpenCode fails (default `false`; batch only) |
| `model` | Override `opencodeModel` for this agent only |
| `autoApprovePermissions` | Override Settings auto-approve for OpenCode tool permissions |
| `autoCreatePullRequest` | Override the Settings `autoCreatePullRequest` default for this agent only |

### Agent statuses and events

Statuses include `queued`, `running`, `awaiting_input`, `processing`, `completing`, `completed`, `failed`, and `cancelled`. Interactive agents move through `awaiting_input` between turns; batch agents typically go `queued` → `running` → `completed` or `failed`; loop agents stay in `processing` between harness steps (no `awaiting_input`); review agents stay in `processing` while OCR runs (no `awaiting_input` or Finish). `GET /agents` and `GET /agents/:id` include a derived `queue` object with wait reason, predecessor, and `canRetry` / `canAllowSuccessors` for shared-branch chains. The sessions list and session page show that wait reason; a failed or cancelled chunk can **Retry** in place or **Start next queued**, and **Queue another on this branch** prefills a new session on the same head. Completed coding sessions with a pushed branch expose **Review branches** when review is allowed.

SSE event types: `session.status`, `assistant.delta`, `assistant.message`, `tool.start`, `tool.end`, `permission.requested`, `error`, `log.line`, plus loop events `loop.step.start`, `loop.step.end`, and `loop.iteration.end`. The stream closes ~1.5s after a terminal status.

Loop agents expose `agent.loop` on `GET /agents/:id` with fields such as `iteration`, `stepIndex`, `currentVerb`, `maxIterations`, `canFinish`, and `finishRequested`.

`GET /messages` returns `{ agentId, messages, lastEventSeq, events }`. For batch agents with no conversation file yet, `messages` contains the initial user prompt.

### Webhooks

When `webhookUrl` is set, the server POSTs JSON to that URL when an agent reaches a terminal status. Payload shape: `{ event, agent, timestamp }` where `event` is `agent.completed`, `agent.failed`, or `agent.cancelled`.

### Pull requests

`POST .../pull-request` requires `status: completed`, OpenCode success, `pushed: true`, and no existing `pullRequest` on the agent (409 `PR_NOT_READY` or `PR_EXISTS` otherwise). When Ollama is configured, title and body are generated by the local LLM from the task, agent summary, commit message, and git diff; otherwise they default from the commit message, prompt, and branch metadata. `GET .../pull-request` refreshes `state`, `mergedAt`, and related fields from GitHub (404 `PR_NOT_FOUND` if none linked).

Environment: `MAX_CONCURRENT_AGENTS` (default `3`), `AGENT_TIMEOUT` seconds for batch workers (default `3600`), `OPENCODE_BIN` (default `opencode`), `OPENCODE_PORT_BASE` (default `4100`), `OPENCODE_STARTUP_TIMEOUT_MS` (default `900000`). Remove finished sessions with `POST /api/v1/agents/<agentId>/delete` (or the UI) to delete logs, events, and workspace data.
