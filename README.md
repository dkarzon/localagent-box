# Local Agent Box

Locally hosted version of a Cursor Cloud Agent.
> Spin up, check out, push code


## Quick start

```bash
docker compose up -d --build
```

Open the management UI at [http://localhost:8080](http://localhost:8080). The default API token is `localagent-box` (pre-filled in the UI). Override with the `API_TOKEN` environment variable in production.

## Local development

The repo has two parts: a **TypeScript Node.js API** in `src/` (compiled to `dist/`) and a **React + Vite UI** in `client/`. In production and Docker, the API serves the built UI from `public/`. For day-to-day UI work, run both processes with hot reload.

### Prerequisites

- **Node.js** ≥ 20
- **Git** (clone/verify/push)
- **Ollama** — optional for health checks; required to run agents against a local model
- **OpenCode CLI** — `npm install -g opencode-ai` (needed when starting agent jobs locally)

### Install dependencies

From the repo root:

```bash
npm install --ignore-scripts
npm install --prefix client
```

Use `--ignore-scripts` on the root install if the `postinstall` hook loops on your machine; then install the client explicitly as shown.

### Option A — UI + API with hot reload (recommended)

Use two terminals.

**Terminal 1 — API** (TypeScript, auto-restarts on change):

```bash
# Windows (PowerShell)
$env:PORT="8081"; $env:DATA_DIR="./data"; npm run dev

# macOS / Linux
PORT=8081 DATA_DIR=./data npm run dev
```

The Vite dev server proxies `/api` and `/health` to port **8081** (see `client/vite.config.ts`), so the API must listen on 8081 during UI development.

**Terminal 2 — UI**:

```bash
npm run dev:ui
```

Open [http://localhost:5173](http://localhost:5173). API requests are proxied to the backend on 8081.

Persisted state (config, repos, agents) is written under `./data/` when `DATA_DIR=./data` is set. Agent git workspaces use `./data/workspace/agents/` on Windows.

### Option B — Single server (production-like)

Build the UI and API, then serve everything from one process on port 8080:

```bash
npm run build:ui
npm run build
npm start
```

Open [http://localhost:8080](http://localhost:8080).

### Option C - Local Docker build and run

Run once to create the volume (shared across docker sessions)
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
| `PORT` | `8080` | HTTP listen port (`8081` when using Option A) |
| `DATA_DIR` | `/data` | Config and agent state directory (use `./data` locally) |
| `API_TOKEN` | `localagent-box` | Bearer token for mutating API calls |
| `OLLAMA_BASE_URL` | — | Bootstrap Ollama URL on first start (e.g. `http://localhost:11434`) |
| `AGENT_WORKSPACE` | platform-specific | Directory for ephemeral agent clones |
| `MAX_CONCURRENT_AGENTS` | `3` | Concurrent agent workers |
| `AGENT_TIMEOUT` | `3600` | Batch worker timeout in seconds |
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


- [x] Build Docker image with opencode deps
- [x] Setup opencode config (local Ollama)
- [x] Use Github App Auth as a replacement for ssh
- [x] Checkout git repo
- [x] Create branch
- [x] Accept opencode command to execute
- [x] Commit and push code
- [ ] Document Github App install process

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
| `interactiveAgentTimeoutSeconds` | Interactive session timeout in seconds (default `3600`; separate from `AGENT_TIMEOUT` for batch workers) |
| `loopAgentTimeoutSeconds` | Loop session timeout in seconds (default `3600`; separate from `AGENT_TIMEOUT` for batch workers) |
| `loopVerbModels` | Per-verb model overrides for loop mode (`INITIAL_PLAN`, `ORIENT`, `ACT`, `REFLECT`). Empty string on a verb uses the fallback chain below. Legacy `OBSERVE`/`PLAN` keys are accepted and folded into `ORIENT`. |

Batch, loop, and interactive agents all run through `opencode serve` with per-agent isolated config at `{dataDir}/agents/{agentId}/opencode-config/opencode.json`. Per-agent `autoApprovePermissions` on create overrides the mode default from Settings.

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

Agents support three modes:

| Mode | Behavior |
|------|----------|
| **`batch`** (default) | Single prompt → `opencode serve` (session orchestrator) → auto commit/push → terminal status. Best for API, CI, and one-shot UI runs. |
| **`interactive`** | Multi-turn session on the same OpenCode server. Follow-up messages when `status` is `awaiting_input`; call **Finish** to commit/push. |
| **`loop`** | Config-driven harness: observe → plan → act → reflect cycles until the model emits `LOOP_COMPLETE: true` on REFLECT or host caps are hit. Create-time `prompt` is the **goal**; step prompts come from `loop.json`. Optional per-verb models in Settings (`loopVerbModels`). Single commit/push at end (or early **Finish**). |

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

Each agent gets an isolated git workspace under `AGENT_WORKSPACE` (default `{DATA_DIR}/workspace/agents/<workspaceId>/` on Windows, `/workspace/agents/<workspaceId>/` in Docker). Agent metadata, logs, events, and per-agent OpenCode config live under `{DATA_DIR}/agents/{agentId}/`. All modes use `opencode serve` with the session orchestrator; interactive workers poll an inbox for follow-ups until Finish; loop workers drive multi-step harness cycles from config. Multiple sessions may share an `agentBranch`; at most one worker runs per `(repoId, agentBranch)` and a later session starts only after the previous one on that branch completed and pushed.

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
| `mode` | `batch` (default), `interactive`, or `loop` |
| `baseBranch` | Base to clone (default: repo `defaultBranch` or `main`) |
| `systemPrompt` | Optional per-agent system prompt |
| `commitMessage` | Git commit message (default `Agent: <agentBranch>`; used on Finish for interactive) |
| `push` | Push branch after commit (default `true`) |
| `pushOnFailure` | Commit/push even when OpenCode fails (default `false`; batch only) |
| `model` | Override `opencodeModel` for this agent only |
| `autoApprovePermissions` | Override Settings auto-approve for OpenCode tool permissions |

### Agent statuses and events

Statuses include `queued`, `running`, `awaiting_input`, `processing`, `completing`, `completed`, `failed`, and `cancelled`. Interactive agents move through `awaiting_input` between turns; batch agents typically go `queued` → `running` → `completed` or `failed`; loop agents stay in `processing` between harness steps (no `awaiting_input`). `GET /agents` and `GET /agents/:id` include a derived `queue` object with wait reason, predecessor, and `canRetry` / `canAllowSuccessors` for shared-branch chains.

SSE event types: `session.status`, `assistant.delta`, `assistant.message`, `tool.start`, `tool.end`, `permission.requested`, `error`, `log.line`, plus loop events `loop.step.start`, `loop.step.end`, and `loop.iteration.end`. The stream closes ~1.5s after a terminal status.

Loop agents expose `agent.loop` on `GET /agents/:id` with fields such as `iteration`, `stepIndex`, `currentVerb`, `maxIterations`, `canFinish`, and `finishRequested`.

`GET /messages` returns `{ agentId, messages, lastEventSeq, events }`. For batch agents with no conversation file yet, `messages` contains the initial user prompt.

### Webhooks

When `webhookUrl` is set, the server POSTs JSON to that URL when an agent reaches a terminal status. Payload shape: `{ event, agent, timestamp }` where `event` is `agent.completed`, `agent.failed`, or `agent.cancelled`.

### Pull requests

`POST .../pull-request` requires `status: completed`, OpenCode success, `pushed: true`, and no existing `pullRequest` on the agent (409 `PR_NOT_READY` or `PR_EXISTS` otherwise). When Ollama is configured, title and body are generated by the local LLM from the task, agent summary, commit message, and git diff; otherwise they default from the commit message, prompt, and branch metadata. `GET .../pull-request` refreshes `state`, `mergedAt`, and related fields from GitHub (404 `PR_NOT_FOUND` if none linked).

Environment: `MAX_CONCURRENT_AGENTS` (default `3`), `AGENT_TIMEOUT` seconds for batch workers (default `3600`), `OPENCODE_BIN` (default `opencode`), `OPENCODE_PORT_BASE` (default `4100`), `OPENCODE_STARTUP_TIMEOUT_MS` (default `900000`). Remove finished sessions with `POST /api/v1/agents/<agentId>/delete` (or the UI) to delete logs, events, and workspace data.
