# Phase 0 — DeepSeek Harness + Ollama spike

Validates that **DeepSeek Harness (DSH)** can run against a local **Ollama** instance using the **`dsh --profile sdk`** stdio JSON-RPC path — the integration model planned for localagent-box.

This is throwaway infrastructure under `scripts/spike/`; it does not modify the production worker.

## Pinned versions (tested target)

| Package | Version |
|---------|---------|
| `@deepseek-ai/dsh` | `0.1.2-alpha.2` |
| `@deepseek-ai/dsh-sdk-client` | `0.1.2-alpha.2` |
| `@deepseek-ai/dsh-sdk-app` | `0.1.2-alpha.2` (installed into profile on first run) |

Update these together when bumping DSH in later phases.

## What the spike proves

1. `dsh --profile sdk` starts inside a Linux container (Node `trixie`, same family as localagent-box)
2. Ollama is reachable from the container via OpenAI-compatible `/v1`
3. `settings.yaml` with `llm-pi-ai.providers.ollama` + `permission.defaultPreset: danger-full-access` works unattended
4. The model invokes at least one tool (`tool/call` in session log)
5. A `turn/end` event is observed and `spike.txt` is created in the workspace

## Quick run (Docker — recommended)

Requires Docker with Compose v2.

```bash
cd scripts/spike
docker compose up --build --abort-on-container-exit
```

First run pulls `llama3.2` into the Ollama volume (slow). Subsequent runs reuse the cached model.

### Environment overrides

| Variable | Default | Purpose |
|----------|---------|---------|
| `DSH_MODEL` | `llama3.2` | Ollama model tag |
| `SPIKE_TIMEOUT_MS` | `900000` | Overall timeout (15 min) |
| `SPIKE_PROMPT` | (built-in) | Override task text |
| `SPIKE_SKIP_OLLAMA_PROBE` | — | Set `1` to skip `GET /api/tags` |

Example with a different model:

```bash
DSH_MODEL=qwen3:8b docker compose up --build --abort-on-container-exit
```

## Prerequisites (local run)

- **Node.js** ≥ 20
- **pnpm** via Corepack (`corepack enable`) — required once to bootstrap the `sdk` profile
- **Ollama** running with the chosen model pulled

In `@deepseek-ai/dsh@0.1.1-rc.2`, only `web` and `headless` profiles auto-initialize. The spike bootstraps `sdk` automatically on first run:

```text
dsh plugin --profile sdk add @deepseek-ai/dsh-sdk-app@0.1.2-alpha.2
```

Profile state is cached under `spike-runs/_dsh-home/`. If bootstrap failed partway (wrong `dsh-sdk-app` version, init timeout), delete the **entire** folder and re-run:

```powershell
Remove-Item -Recurse -Force scripts\spike\spike-runs\_dsh-home
```

The spike auto-repairs incomplete `profiles/sdk` directories, but a half-initialized profile can still cause `harness.start()` to hang until the 10-minute timeout.

**Windows note:** DSH agent tooling targets Linux/macOS. If `harness.start()` hangs locally, use `docker compose up` instead.

## Local run (host Ollama)

```bash
cd scripts/spike
npm install
export OLLAMA_BASE_URL=http://127.0.0.1:11434
export DSH_MODEL=llama3.2:3b
npm run spike
```

On Windows PowerShell:

```powershell
cd scripts/spike
npm install
$env:OLLAMA_BASE_URL = "http://127.0.0.1:11434"
$env:DSH_MODEL = "llama3.2:3b"
npm run spike
```

## Run inside the production localagent-box image (optional)

After installing DSH globally in the image (Phase 9), you can mount this folder:

```bash
docker run --rm -it \
  -e OLLAMA_BASE_URL=http://host.docker.internal:11434 \
  --add-host=host.docker.internal:host-gateway \
  -v "$(pwd)/scripts/spike:/spike" \
  -w /spike \
  ghcr.io/dkarzon/localagent-box:latest \
  bash -lc "npm install && node dsh-ollama-spike.mjs"
```

(Requires `@deepseek-ai/dsh` in the image — not yet added to the main Dockerfile.)

## Outputs

| Path | Description |
|------|-------------|
| `spike-runs/_dsh-home/` | Shared `DSH_HOME` (`settings.yaml`, `profiles/sdk/`) |
| `spike-runs/<timestamp>/workspace/` | Per-run agent workspace |
| `fixtures/sample-notifications.jsonl` | Truncated tool/turn notifications for Phase 4 mapper |
| `fixtures/last-run-summary.json` | Event counts from last successful run |

`fixtures/sample-notifications.jsonl` is gitignored until a successful run generates it; copy a redacted sample into the repo if you want fixtures checked in.

## Configuration notes

### Ollama provider (`settings.yaml`)

Written by `lib/write-dsh-settings.mjs`:

- `baseURL` must end with `/v1`
- `apiKeyEnv: OLLAMA_API_KEY` — set env to any non-empty string
- `compat.supportsDeveloperRole: false` — required for many Ollama models
- `permission.defaultPreset: danger-full-access` — **required** for unattended tool runs in Docker (no approval UI; matches localagent-box batch posture)

### SDK launch

The spike uses `@deepseek-ai/dsh-sdk-client` `DeepSeekHarness` with:

```js
launch: {
  command: process.execPath,
  args: [dshBin, '--profile', 'sdk'],
  env: { ...process.env, DSH_HOME, OLLAMA_API_KEY },
}
```

DSH has **no HTTP serve mode** like OpenCode; stdio JSON-RPC is the correct automation path.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `profile "sdk" does not exist` | Run spike again — it bootstraps automatically; needs **pnpm** (`corepack enable` or install pnpm globally) |
| Hangs at `Starting DSH runtime` | Broken profile: delete `spike-runs/_dsh-home/profiles/sdk` and re-run; or use Docker |
| `llama3.2` / model not found | Set `DSH_MODEL` to an exact tag from `ollama list` (e.g. `llama3.2:3b`) |
| `no adapter registered for provider "ollama"` | Delete entire `spike-runs/_dsh-home` and re-run (first run warms up ~15s) |
| `dsh-sdk-app@0.1.1-rc.2` not found | Upgrade spike deps: `npm install` (uses `0.1.2-alpha.2`) |
| `Could not resolve dsh binary` | Run `npm install` in `scripts/spike` |
| Ollama probe failed | Start Ollama or use `docker compose` stack |
| `MISSING_CREDENTIAL` | Spike writes `$DSH_HOME/.credentials.yaml` automatically; or set `OLLAMA_API_KEY` in env |
| `UNKNOWN_MODEL` | `ollama pull <model>` |
| HTTP 400 `developer` role | Already handled via `compat.supportsDeveloperRole: false` |
| No `tool/call` events | Try a larger model; small models may not tool-call reliably |
| Spike timeout | Increase `SPIKE_TIMEOUT_MS`; first model pull is slow |

## Phase 0 results (fill in after first green run)

| Metric | Value |
|--------|-------|
| Date | _run `docker compose up` locally_ |
| `@deepseek-ai/dsh` | `0.1.2-alpha.2` |
| Cold-start (`initialize`) | _pending ms_ |
| Run duration | _pending ms_ |
| `danger-full-access` required | **Yes** (expected) |
| Model used | `llama3.2` (default; override with `DSH_MODEL`) |
| Unit tests | `node --test lib/write-dsh-settings.test.mjs` — pass |
| E2E | Pending — requires Docker daemon + `docker compose up` |

## Next phase

See [deepseek-harness-integration.plan.md](../../docs/plans/deepseek-harness-integration.plan.md) Phase 1 — `codingHarness` config flag and `HarnessRunner` interface.
