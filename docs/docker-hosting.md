# Docker hosting (prebuilt image)

Use the published image from GitHub Container Registry when you want to run localagent-box without building from source.

**Image:** [`ghcr.io/dkarzon/localagent-box`](https://github.com/dkarzon/localagent-box/pkgs/container/localagent-box)

```bash
docker pull ghcr.io/dkarzon/localagent-box:latest
```

Tagged releases are also published as `ghcr.io/dkarzon/localagent-box:<version>` (see package tags on GHCR).

## Quick start

Create persistent volumes once:

```bash
docker volume create localagent-data
docker volume create localagent-workspace
```

Run the container (replace `your-secret-token` with a strong value):

```bash
docker run -d \
  --name localagent-box \
  --restart unless-stopped \
  -p 8080:8080 \
  -e NODE_ENV=production \
  -e API_TOKEN=your-secret-token \
  -e OLLAMA_BASE_URL=http://host.docker.internal:11434 \
  -e OPENCODE_MODEL=llama3.2 \
  --add-host=host.docker.internal:host-gateway \
  -v localagent-data:/data \
  -v localagent-workspace:/workspace \
  ghcr.io/dkarzon/localagent-box:latest
```

Open [http://localhost:8080](http://localhost:8080). Enter the same `API_TOKEN` in the UI (Settings → API Access).

**First container start** may take several minutes while OpenCode’s SQLite database is pre-migrated into the data volume. Later starts reuse that template and boot much faster. Watch logs with `docker logs -f localagent-box`.

Next: [set up a GitHub App](./github-app-setup.md) so agents can clone, commit, and open PRs. Optional: enable [automatic PR reviews](./code-review.md) with Open Code Review.

## Docker Compose

Example `compose.yaml` using the GHCR image (no local build):

```yaml
services:
  localagent-box:
    image: ghcr.io/dkarzon/localagent-box:latest
    container_name: localagent-box
    restart: unless-stopped
    ports:
      - "8080:8080"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      NODE_ENV: production
      API_TOKEN: ${API_TOKEN:?set API_TOKEN in .env or shell}
      PORT: "8080"
      DATA_DIR: "/data"
      OLLAMA_BASE_URL: ${OLLAMA_BASE_URL:-http://host.docker.internal:11434}
      OPENCODE_MODEL: ${OPENCODE_MODEL:-}
      OPENCODE_PROVIDER: ${OPENCODE_PROVIDER:-ollama}
      MAX_CONCURRENT_AGENTS: "3"
      AGENT_TIMEOUT: "3600"
    volumes:
      - agent-data:/data
      - agent-workspace:/workspace

volumes:
  agent-data:
  agent-workspace:
```

Create a `.env` next to the compose file:

```bash
API_TOKEN=your-secret-token
OLLAMA_BASE_URL=http://host.docker.internal:11434
OPENCODE_MODEL=llama3.2
```

Then:

```bash
docker compose up -d
```

The repo’s root [`docker-compose.yml`](../../docker-compose.yml) builds from source instead of pulling GHCR; use the example above when you only want the published image.

## Required environment variables

| Variable | Required | Notes |
|----------|----------|--------|
| `API_TOKEN` | **Yes** | Bearer token for mutating API calls and the UI. Must **not** be the default `localagent-box` when `NODE_ENV=production` (the server refuses to start otherwise). |
| `NODE_ENV` | **Strongly recommended** | Set to `production` for any real deployment so the default-token guard is active. |
| `OLLAMA_BASE_URL` | **Yes for local Ollama** | URL reachable **from inside the container**. On Docker Desktop use `http://host.docker.internal:11434`; on Linux add `--add-host=host.docker.internal:host-gateway` (or `extra_hosts` in Compose). Do not use `localhost` — that points at the container, not your host. |

Everything else has sensible defaults inside the image (`PORT=8080`, `DATA_DIR=/data`, agent workspaces under `/workspace/agents`).

GitHub App credentials (`githubAppId`, `githubAppInstallationId`, `githubAppPrivateKey`) are **not** environment variables — configure them in the UI or via `PUT /api/v1/config` after the container is running. See [github-app-setup.md](./github-app-setup.md).

## Optional environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8080` | HTTP listen port |
| `DATA_DIR` | `/data` | Config, repos, agents, and OpenCode template on disk — **mount a volume here** |
| `AGENT_WORKSPACE` | `/workspace/agents` (Linux container) | Ephemeral git clones per agent — **mount a volume on `/workspace`** in production |
| `OLLAMA_BASE_URL` | — | Bootstrap Ollama URL on first start if not already in config |
| `OPENCODE_MODEL` | — | Bootstrap default model (e.g. `llama3.2`) |
| `OPENCODE_PROVIDER` | — | Bootstrap provider id (default `ollama`) |
| `MAX_CONCURRENT_AGENTS` | `3` | Concurrent agent worker processes |
| `AGENT_TIMEOUT` | `3600` | Batch worker timeout in seconds (from worker start, not queue wait) |
| `OCR_BIN` | `ocr` | Open Code Review CLI (preinstalled in the image; see [code-review.md](./code-review.md)) |
| `OCR_REVIEW_TIMEOUT` | `30` | Per-file OCR review deadline in minutes (`0` disables) |
| `OCR_LLM_TIMEOUT` | `600` | Per-request OCR LLM HTTP timeout in seconds |
| `OPENCODE_BIN` | `opencode` | OpenCode CLI (preinstalled in the image) |
| `OPENCODE_PORT_BASE` | `4100` | Base port for per-agent `opencode serve` |
| `OPENCODE_STARTUP_TIMEOUT_MS` | `900000` | Max wait for `opencode serve` to become ready |
| `ENABLE_CODEGRAPH` | `false` | Set to `true` to expose the codegraph MCP server to agents |
| `LOG_LEVEL` | `info` in production | Pino log level |
| `MAX_BODY_BYTES` | `5242880` | Max HTTP request body size |
| `SHUTDOWN_TIMEOUT_MS` | `30000` | Graceful shutdown window |

## Volumes

| Mount | Purpose |
|-------|---------|
| `/data` | `config.json`, `repos.json`, `agents.json`, per-agent logs/events, OpenCode DB template |
| `/workspace` | Agent git workspaces (`/workspace/agents/<id>/`) |

Without these volumes, all state is lost when the container is removed.

## Ollama on the host

The container cannot reach Ollama at `http://localhost:11434` on your machine. Point `OLLAMA_BASE_URL` at an address the container can use:

- **Docker Desktop (Windows/macOS):** `http://host.docker.internal:11434`
- **Linux:** `http://host.docker.internal:11434` with `host-gateway` mapping (see `docker run` / Compose examples above), or your host’s LAN IP

Verify from the UI (Settings → Ollama Status) or:

```bash
curl http://localhost:8080/health
```

## Security

- Set a strong `API_TOKEN` and `NODE_ENV=production` before exposing the service beyond a quick local trial.
- Most `GET` endpoints (config, logs, SSE events) are intentionally unauthenticated — deploy on a trusted LAN/VPN only, or behind a reverse proxy with TLS and additional auth. See [SECURITY.md](../SECURITY.md).
- The data volume holds your GitHub App private key in plaintext — protect it like an SSH key.

## Build vs pull

| Approach | When to use |
|----------|-------------|
| `docker pull ghcr.io/dkarzon/localagent-box:latest` | Normal hosting; fastest setup |
| `docker compose up -d --build` (repo root) | Developing or patching the image yourself |
