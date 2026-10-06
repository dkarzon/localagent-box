# Deploy localagent-box MCP server

Expose localagent-box state and read-only diagnostics as a Model Context Protocol (MCP) server so external agents (or the project's own OpenCode agents) can query runs, repos, and health without mutating anything.

**Status:** Plan — Phase 1 in progress

**Related:** `src/mcp/server.ts`, `src/config/env.ts`, `README.md`, `docs/docker-hosting.md`

---

## Goal

Operators and agents can connect to localagent-box through an MCP client and use read-only tools to inspect:

- Server health
- Registered repos
- Queued/running/completed agents
- Agent logs
- Public config (secrets redacted)

Phase 1 is intentionally read-only and API-key authenticated. Mutating tools come in later phases.

---

## Decisions (locked)

| # | Decision |
|---|---|
| 1 | Transport is **stdio** (local command), matching how OpenCode already spawns MCP servers. |
| 2 | Auth uses a single **API token** shared with the HTTP API (`API_TOKEN`). A dedicated `MCP_API_TOKEN` can override it. |
| 3 | Phase 1 tools are **read-only GET wrappers** around existing `/api/v1/*` endpoints. |
| 4 | The MCP server is a separate entrypoint (`localagent-box-mcp-server`) that calls back to the HTTP API over `LOCALAGENT_BOX_URL`. |
| 5 | No new runtime dependencies beyond Node's built-ins. |
| 6 | Errors from the HTTP API are forwarded as MCP JSON-RPC errors. |

---

## Out of scope (this pass)

- Mutating tools (`start_agent`, `delete_agent`, `register_repo`, `update_config`)
- Resources/prompts beyond the public config
- SSE or HTTP transport
- Per-tool fine-grained permissions

---

## Phase 1: API keys and read-only tools

### Configuration

| Env var | Default | Purpose |
|---|---|---|
| `LOCALAGENT_BOX_URL` | `http://localhost:8080` | Base URL of the localagent-box HTTP API to call back into. |
| `MCP_API_TOKEN` | `$API_TOKEN` | Bearer token for the MCP server's calls to the HTTP API. Falls back to `API_TOKEN`, then to the default token only for local development. |

The MCP server does **not** need its own enable flag; it is spawned explicitly as an MCP command by an OpenCode client or run manually.

### Tools

All tools map to existing `GET` endpoints and include the bearer token in `Authorization`.

| Tool | Endpoint | Arguments |
|---|---|---|
| `health_check` | `GET /health` | none |
| `list_repos` | `GET /api/v1/repos` | none |
| `get_repo` | `GET /api/v1/repos/:repoId` | `{ repoId: string }` |
| `list_agents` | `GET /api/v1/agents` | `{ repoId?: string, status?: string }` |
| `get_agent` | `GET /api/v1/agents/:agentId` | `{ agentId: string }` |
| `get_agent_logs` | `GET /api/v1/agents/:agentId/logs?tail=` | `{ agentId: string, tail?: number }` |
| `get_config` | `GET /api/v1/config` | none |

### Implementation

1. New file `src/mcp/server.ts` implementing JSON-RPC over `process.stdin` / `process.stdout`.
2. Standard MCP lifecycle: `initialize`, `initialized`, `tools/list`, `tools/call`.
3. Each `tools/call` makes an authenticated `fetch` to `LOCALAGENT_BOX_URL` and returns JSON content.
4. Add `npm run mcp-server` script that runs `tsx src/mcp/server.ts`.
5. Add `dist/mcp/server.js` as the production entrypoint after `npm run build`.

### Tests

- `src/mcp/server.test.ts`: spawn the server as a child process, send `initialize` and `tools/list`, and verify the read-only tool set is exposed.
- Mock the HTTP API with a tiny local Node HTTP server to verify auth header forwarding and response passthrough.

### Docs

- Add `LOCALAGENT_BOX_URL` and `MCP_API_TOKEN` to `.env.example`.
- Mention the MCP server in `README.md` API section.
- Mention optional hosting in `docs/docker-hosting.md`.

---

## Follow-up phases

- **Phase 2:** Mutating tools (`start_agent`, `send_message`, `finish`, `delete`).
- **Phase 3:** Resources (`agent://{agentId}`, `repo://{repoId}`) and prompts.
- **Phase 4:** Packaging in Docker image and default `opencode.json` snippet.

---

## Assumptions

- The localagent-box HTTP API is reachable from the MCP server process.
- The existing `API_TOKEN` is set before spawning the MCP server in production.
- OpenCode clients using this MCP server run in a trusted environment (the token travels from the MCP server to the HTTP API over localhost).
