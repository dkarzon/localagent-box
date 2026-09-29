# Ollama Cloud provider + split Settings

Add **Ollama Cloud** as a first-class LLM host alongside local Ollama, and split Settings into bookmarkable sub-pages. OpenCode and Open Code Review (OCR) choose providers independently.

**Status:** Plan

**Related:** [OpenCode providers](https://opencode.ai/docs/providers/), [Ollama Cloud](https://docs.ollama.com/cloud), [code-review.md](../code-review.md), `src/services/opencode-config.ts`, `src/integrations/open-code-review/runner.ts`, `client/src/pages/SettingsPage.tsx`

---

## Goal

Operators can:

- Connect **local Ollama** (URL, no key) and/or **Ollama Cloud** (API key, no local daemon)
- Point **OpenCode** at one host and **OCR** at the other
- Run Cloud-only (empty `ollamaBaseUrl`) without the UI treating the system as offline
- Manage settings on **General / Models / GitHub / OpenCode / OCR** instead of one long form

Typical setup: Cloud for coding, local for review (or the reverse).

---

## Decisions (locked)

| # | Decision |
|---|----------|
| 1 | OpenCode and OCR have **independent** provider + model defaults. Credentials are shared. |
| 2 | **v1 providers:** local Ollama + Ollama Cloud only. Anthropic and OpenAI are deferred. |
| 3 | Auth is **API key** (Cloud). No Claude/ChatGPT subscription OAuth. |
| 4 | Cloud is a **direct remote host** (`https://ollama.com` + bearer key). Do **not** require local `ollama pull *:cloud`. |
| 5 | Settings: one sidebar item; in-page sub-nav; routes `/settings`, `/settings/models`, `/settings/github`, `/settings/opencode`, `/settings/ocr`. |
| 6 | Save **only the active page** via existing partial `PUT /api/v1/config`. |
| 7 | **Models** = connection + probe + catalog. Defaults live on OpenCode / OCR pages. |
| 8 | Auto-create PR → General. Auto-review PRs → OCR. GitHub App fields → GitHub. |
| 9 | Loop verb models stay on the **OpenCode** provider (no per-verb provider mix). |
| 10 | Host PR-title generation follows the **OpenCode** provider, not always local Ollama. |
| 11 | Readiness is **per consumer**: coding UI uses OpenCode’s host; review UI uses OCR’s host. |
| 12 | Existing installs keep `opencodeProvider: ollama`. Empty `reviewProvider` inherits OpenCode’s provider. |

---

## Out of scope (this pass)

- Anthropic, OpenAI, OpenRouter, and other OpenCode catalog providers
- Claude Pro / ChatGPT Plus device-code OAuth
- Routing Cloud through a local Ollama daemon
- Per-loop-verb or per-agent **provider** overrides (per-agent **model** override stays)
- Changing OCR concurrency/timeouts (still env: `OCR_LLM_TIMEOUT`, etc.)
- Cross-page Settings search

---

## Current state

Everything assumes a single local Ollama:

| Surface | Behavior |
|---------|----------|
| Config | `ollamaBaseUrl` + `opencodeProvider` (default `ollama`) + `opencodeModel` + `reviewModel` |
| OpenCode `opencode.json` | Always `@ai-sdk/openai-compatible` named “Ollama (local)”, `baseURL` from `ollamaBaseUrl`. `writeOpenCodeConfig` no-ops if URL empty. |
| OCR | Always `{ollamaBaseUrl}/v1/chat/completions`, token `ollama`, `OCR_USE_ANTHROPIC=false`. Throws if URL empty. |
| Health | `GET /health` → `{ ollama }` from `{url}/api/tags` with no auth |
| PR titles | `ollama-client` `POST {url}/api/chat`; skips if URL empty |
| Agent create | Model dropdowns from `health.ollama.models`; “system online” = local reachable |
| Settings | One page, one save |

Ollama Cloud is the same native API as local (`/api/tags`, `/api/chat`, OpenAI-compat `/v1`), plus `Authorization: Bearer <key>`. Official host: `https://ollama.com`. List/use API model ids (e.g. `gemma4:31b`), not CLI `*:cloud` aliases.

---

## Config

Keep `ollamaBaseUrl` as the local URL (no migration of existing files). Add Cloud + OCR provider fields.

```ts
export const LLM_PROVIDER_IDS = ['ollama', 'ollama-cloud'] as const;
export type LlmProviderId = (typeof LLM_PROVIDER_IDS)[number];

export const DEFAULT_OLLAMA_CLOUD_BASE_URL = 'https://ollama.com';

export interface AppConfig {
  // local
  ollamaBaseUrl: string;
  // cloud (secret — same *** / omit-on-public pattern as githubAppPrivateKey)
  ollamaCloudApiKey: string;
  /** Empty → DEFAULT_OLLAMA_CLOUD_BASE_URL */
  ollamaCloudBaseUrl: string;

  opencodeProvider: LlmProviderId; // default 'ollama'
  opencodeModel: string;
  /** Empty → inherit opencodeProvider */
  reviewProvider: LlmProviderId | '';
  reviewModel: string;
  // ...unchanged fields
}
```

**Public GET** never returns the raw Cloud key: `ollamaCloudApiKey: '***' | ''` plus `hasOllamaCloudApiKey: boolean`.

**PUT** treats `***` and empty-with-existing-key as “leave unchanged” (copy the GitHub private-key branch in `src/routes/config.ts`).

**Bootstrap env** (first start only, same as `OLLAMA_BASE_URL`):

| Env | Config field |
|-----|----------------|
| `OLLAMA_CLOUD_API_KEY` | `ollamaCloudApiKey` |
| `OLLAMA_CLOUD_BASE_URL` | `ollamaCloudBaseUrl` (optional) |

Validate `opencodeProvider` / `reviewProvider` as known ids (empty review provider allowed). Validate Cloud base URL when non-empty.

**Helpers** (new `src/lib/llm-provider.ts`):

```ts
isProviderConfigured(config, id): boolean
  ollama        → ollamaBaseUrl non-empty
  ollama-cloud  → api key non-empty

resolveOpenCodeProvider(config) → opencodeProvider || 'ollama'
resolveReviewProvider(config)   → reviewProvider || resolveOpenCodeProvider(config)

resolveProviderHost(config, id) → { baseUrl, apiKey | undefined }
  ollama        → { baseUrl: ollamaBaseUrl }
  ollama-cloud  → { baseUrl: ollamaCloudBaseUrl || DEFAULT, apiKey }
```

---

## Provider runtime

Local and Cloud share Ollama’s HTTP API. Generalize; do not fork OCR/OpenCode paths.

### Probe

Extend `createOllamaProbe().probe(baseUrl)` → `probe({ baseUrl, apiKey? })`.

- `GET {normalized}/api/tags`
- If `apiKey`, send `Authorization: Bearer …`
- 401/403 → `reachable: false`, message invalid/missing key
- Empty base URL → `not_configured` (unchanged)

`GET /health`:

```json
{
  "status": "ok",
  "service": "localagent-box",
  "ollama": { "...local probe..." },
  "providers": {
    "ollama": { "...same as ollama..." },
    "ollama-cloud": { "...cloud probe..." }
  }
}
```

Keep top-level `ollama` as an alias of `providers.ollama` so older clients do not break mid-rollout. Agent UI should read `providers[id]`.

Probe both hosts in parallel.

### Chat (PR titles)

`ollama-client.generateText` uses `resolveOpenCodeProvider` + `resolveProviderHost`. Skip (warn) when that host is not configured — same as today when URL is empty. Strip `ollama/` **and** `ollama-cloud/` prefixes from stored model ids if present.

### OpenCode `opencode.json`

`writeOpenCodeConfig` succeeds when the **OpenCode** provider is configured, not when local URL is set.

Build **only that provider** (loop verbs share it):

| Provider | `npm` | `name` | `options` |
|----------|-------|--------|-----------|
| `ollama` | `@ai-sdk/openai-compatible` | Ollama (local) | `{ baseURL: <url>/v1 }` |
| `ollama-cloud` | `@ai-sdk/openai-compatible` | Ollama Cloud | `{ baseURL: <url>/v1, apiKey }` |

`model` remains `{providerID}/{modelID}` (e.g. `ollama-cloud/gemma4:31b`). Register loop verb model ids on that same provider.

Per-agent config already lives under `{DATA_DIR}/agents/{id}/opencode-config/` (not the git workspace). Putting `apiKey` in `options` is acceptable; it must never appear in `PublicConfig` or UI payloads.

On Settings save, rewrite global `~/.config/opencode/opencode.json` only if the OpenCode provider is configured (today this is gated on `ollamaBaseUrl`).

### OCR

`buildOcrLlmSettings` uses `resolveReviewProvider` + review/fallback model. Never require local URL.

| Provider | `OCR_LLM_URL` | `OCR_LLM_TOKEN` | `OCR_USE_ANTHROPIC` |
|----------|---------------|-----------------|---------------------|
| `ollama` | `{local}/v1/chat/completions` | `ollama` | `false` |
| `ollama-cloud` | `{cloud}/v1/chat/completions` | Cloud API key | `false` |

Throw a clear error if the chosen OCR provider is not configured.

Review worker log line should print `provider=` as well as `model=`.

---

## Settings UI

Keep **Settings** in the main sidebar. Parse a section from the path (`''` / `models` / `github` / `opencode` / `ocr` → default General). `getPageId` already treats `/settings/*` as Settings.

Sub-nav on every settings page. Sticky footer saves **that page’s payload only**.

| Route | Page | Fields |
|-------|------|--------|
| `/settings` | General | Client API token, webhook URL, workspace cleanup, auto-create PR |
| `/settings/models` | Models | Local URL + probe + model list; Cloud API key + optional base URL + probe + model list |
| `/settings/github` | GitHub | App ID, installation ID, private key, git author |
| `/settings/opencode` | OpenCode | Provider select, default model (that catalog), system prompt, permission auto-approve, timeouts, loop verb models |
| `/settings/ocr` | OCR | Provider select (independent), review model, auto-review PRs |

**Models page:** Refresh probes that page only. Show Cloud key with show/hide, placeholder “stored — paste to replace” when `hasOllamaCloudApiKey`.

**Provider `<select>`:** `Ollama (local)` / `Ollama Cloud`. Disable an option if that provider is not configured; helper text links to Models.

**Model widgets:** combobox/select from `providers[selected].models`. If the saved id is missing from the catalog, keep it as an extra option labeled `(not in catalog)`. Changing provider does not auto-wipe the model string; operator can fix it. Copy-global-to-loop-verbs stays as today.

Split `SettingsPage.tsx` into a layout + five section components under `client/src/pages/settings/`. Shared load/save helpers; do not keep one mega-form.

Existing in-page `searchQuery` filtering applies to the **active** section only.

---

## Agent create / sessions

`AgentSessionsPage` today: `systemOnline = ollama?.reachable !== false` and all model dropdowns from local tags.

Change:

- Load `health.providers`.
- Coding / loop / interactive: catalog + enablement from OpenCode provider.
- Review mode: catalog + enablement from OCR provider.
- Disable start when that consumer’s host is not configured or its catalog is empty (same UX copy, but name the host: “Ollama Cloud unreachable” vs “Ollama unreachable”).
- Session info “Settings default” can show `provider/model`.

Do not block coding on local Ollama when OpenCode is Cloud.

---

## Files (expected)

**Server**

- `src/types/index.ts` — config fields, `LlmProviderId`
- `src/lib/llm-provider.ts` — new resolvers
- `src/services/config-store.ts` — defaults, public redaction
- `src/services/ollama-probe.ts` — optional bearer
- `src/services/ollama-client.ts` — host from OpenCode provider
- `src/services/opencode-config.ts` — provider-specific `opencode.json`; write when OpenCode host configured
- `src/integrations/open-code-review/runner.ts` — OCR env from review provider
- `src/integrations/opencode/runner.ts` — unchanged `providerID/modelID` once config is correct
- `src/lib/pr-content-generator.ts` — skip/generate using OpenCode host
- `src/routes/health.ts` — `providers` map
- `src/routes/config.ts` — Cloud key omit/`***`; provider enum validation; write OpenCode config when OpenCode host configured
- `src/config/env.ts` + `src/server.ts` — Cloud bootstrap env
- `src/domains/agents/worker/review-run-flow.ts` — log provider

**Client**

- `client/src/navigation.ts` — settings section paths
- `client/src/App.tsx` — render settings layout for `/settings/*`
- `client/src/pages/SettingsPage.tsx` → split under `client/src/pages/settings/`
- `client/src/api/types.ts` — new fields, `CONFIG_FIELDS` split per page
- `client/src/pages/AgentSessionsPage.tsx` — per-consumer catalogs

**Docs / env**

- `README.md`, `docs/docker-hosting.md`, `docs/code-review.md`, `.env.example`

---

## Tests

- `llm-provider`: inherit review provider; Cloud default URL; configured/not
- `ollama-probe`: local no-auth; Cloud sends bearer; 401
- `opencode-config`: local vs cloud file shape; no write when selected host missing; Cloud-only does not need `ollamaBaseUrl`
- `open-code-review/runner`: Cloud env (`OCR_LLM_TOKEN` = key, URL `…/v1/chat/completions`, `OCR_USE_ANTHROPIC=false`); local unchanged; throw if OCR host missing
- `config` route: `***` does not wipe Cloud key; empty reviewProvider allowed
- `pr-content-generator`: uses Cloud host when OpenCode is Cloud; skips when that host missing even if local URL set
- `loop-model`: still provider-agnostic model **ids** (no change unless prefix stripping is added)

Client: no new browser suite required; exercise Settings sub-nav, per-page save, and agent-create catalogs manually (or with existing Vite app).

---

## Implementation order

Do this as **one change set** unless it gets too large; boundaries below are the review splits.

1. **Schema + probe** — config fields, public redaction, `llm-provider`, probe/health `providers`, tests
2. **Consumers** — OpenCode config, OCR env, PR chat, review logs, config PUT write condition
3. **Settings split** — routes, five pages, per-page save, Models dual status
4. **Agent UI + docs** — create/session catalogs, README / docker / code-review / `.env.example`

---

## Follow-up (not this pass)

Anthropic and OpenAI reuse the same shape: Settings → Models credentials, independent OpenCode vs OCR defaults.

- OpenCode: native provider ids (`anthropic`, `openai`) rather than openai-compatible + custom base URL
- OCR: Anthropic Messages (`OCR_USE_ANTHROPIC=true`, URL `…/v1/messages`) vs OpenAI chat completions
- PR titles: need a non-Ollama chat client (or OpenAI-compat only for OpenAI; Anthropic Messages separately)
- Consider promoting flat `ollamaCloudApiKey` into a `providers` map once a third vendor lands

---

## Assumptions

- Cloud `/api/tags` accepts the same JSON as local; model `name` values are what we send to `/api/chat` and `/v1/chat/completions`
- OpenCode honors `provider.options.apiKey` for `@ai-sdk/openai-compatible` (documented for custom providers)
- Default Cloud host `https://ollama.com` is correct for both native and `/v1` APIs
- Per-agent `opencode-config/opencode.json` is not committed; no extra gitignore work for the key
