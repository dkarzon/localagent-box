# Pre-release audit

Review of **localagent-box** ahead of open-sourcing and public discussion. Identifies areas to fix or clean up before release. Does not include implemented changes — use this as a checklist.

---

## Critical — fix before announcing

### 1. No `LICENSE` file

`package.json` declares `"license": "MIT"`, but there is no `LICENSE` file in the repo. `docs/pre-release-checklist.md` also lists this as unchecked.

**Why it matters:** Without a license file, contributors and users cannot rely on the stated terms. Legal ambiguity blocks adoption, forks, and corporate use.

---

### 2. Security model is underspecified and risky if exposed

The server listens on **`0.0.0.0`** and many sensitive endpoints require **no authentication**:

| Unauthenticated access | What leaks |
|------------------------|------------|
| `GET /api/v1/config` | GitHub App ID, installation ID, Ollama URL, webhook URL |
| `GET /api/v1/agents`, `GET /agents/:id` | All agent metadata, prompts, branches |
| `GET /agents/:id/logs`, `/messages`, `/events` (SSE) | Full transcripts, tool output, code context |
| `GET /agents/:id/git-status` | Changed file paths |
| `GET /agents/:id/pull-request` | Can refresh PR state from GitHub |

Mutations (create agent, finish, delete, config changes) require Bearer auth, but **reads are wide open** — likely for UI/SSE convenience (`EventSource` cannot send headers; see `client/src/hooks/useAgentEvents.ts`).

Additional concerns:

- **Default token** `localagent-box` is baked into Dockerfile, docker-compose, UI (`client/src/hooks/useApiToken.tsx`), and README.
- Production guard only fires when `NODE_ENV=production`; Docker does **not** set that, so the default token can ship in “production” containers.
- Agent IDs are **12 hex chars** (`crypto.randomUUID().slice(0, 12)` in `agent.service.ts`) — guessable if the service is reachable.

**Why it matters:** Anyone on the LAN (or internet, if port-forwarded) can read agent work, prompts, and repo metadata without a token. Needs a clear **threat model** (“trusted local network only”) and ideally hardening: auth on reads, SSE ticket endpoint, fail startup without `API_TOKEN` in Docker, document reverse-proxy requirements.

**Suggested changes:**

- Add `SECURITY.md` documenting deployment assumptions and hardening options.
- Require non-default `API_TOKEN` in Docker (or set `NODE_ENV=production` in the image).
- Consider SSE auth via short-lived ticket endpoint instead of fully open reads.
- Document that the service must not be exposed to the public internet without a reverse proxy and additional auth.

---

### 3. GitHub App setup is undocumented

README ends with an unchecked item: “Document Github App install process.” The API and Settings UI assume operators know how to create an app, install it, and paste a PEM key — but there is no step-by-step guide (permissions, webhook settings, org vs user install, etc.).

**Why it matters:** This is the main setup friction; without docs, first-run failure is likely and public posts will generate support noise.

**Suggested changes:**

- Add `docs/github-app-setup.md` (or a README section) covering app creation, required permissions, installation, and config fields.

---

### 4. Personal / dev artifacts committed to the repo

| Path | Issue |
|------|--------|
| `.opencode/opencode.json` | References `@tarquinen/opencode-dcp@latest` and `.agents/skills` — author-specific dev config |
| `.localagent-box/loop-plan.md` | Internal planning note |
| `client/src/pages/RepositoriesPage.tsx` | Placeholder `dkarzon` |
| `client/src/pages/AgentSessionsPage.tsx` | Example `dkarzon/localagent-box` |

**Why it matters:** First impressions; new users may think ponytail plugins/skills are required. Personal placeholders look unfinished.

**Suggested changes:**

- Remove or gitignore dev-only OpenCode config; ship a neutral `config/opencode.default.json` only.
- Replace personal placeholders with generic examples (`your-org`, `your-repo`).
- Move internal planning notes out of the tracked tree or into `docs/` with clear “historical” labeling.

---

## High — polish before public launch

### 5. README quality and structure

- Lines 115–122 are an **internal build checklist** mixed into user docs (`- [x] Build Docker image…`).
- Tagline references **“Cursor Cloud Agent”** — consider a trademark disclaimer or neutral wording for public messaging.
- Strong API reference, but missing: architecture overview, security section, GitHub App guide, troubleshooting, “what this is / isn’t.”

**Suggested changes:**

- Move the build checklist to `docs/pre-release-checklist.md` or remove it from README.
- Add sections: Security, Architecture (brief), GitHub App setup (link), Troubleshooting.

---

### 6. No test or lint CI

There are **13 server test files** (`npm test`) and a Docker publish workflow (`.github/workflows/docker-publish.yml`), but **no workflow runs tests on PRs**. No ESLint/Prettier config despite `docs/architecture-recommendations.md` calling for them.

**Why it matters:** External contributors cannot tell if PRs are safe; regressions will slip through.

**Suggested changes:**

- Add `.github/workflows/ci.yml` running `npm run build`, `npm test`, and optionally `npm run build:ui`.
- Add ESLint + Prettier (or document intentional omission).

---

### 7. Stale internal documentation

`docs/architecture-recommendations.md` claims “zero tests,” “no graceful shutdown,” “console.log everywhere” — several items are **already fixed** (pino logging, graceful shutdown in `server.ts`, test suite exists). Keeping outdated docs hurts credibility.

Similarly, many `*.plan.md` files read like internal sprint notes.

**Suggested changes:**

- Update or archive `architecture-recommendations.md` to reflect current state.
- Add `docs/README.md` index separating **user docs** vs **design history**.

---

### 8. Hidden / undocumented config behavior

- **`autoCreatePullRequest`** exists in server config (`src/services/config-store.ts`, `src/domains/agents/agent.service.ts`) but is **not** in `PublicConfig`, README config table, or Settings UI — behavior is invisible to operators (defaults to `true`).
- **`systemPrompt`** is in the API/README but **not** in the Settings UI (`CONFIG_FIELDS` in `client/src/api/types.ts` omits it and several permission/timeout fields).

**Why it matters:** Silent defaults surprise users; API/UI drift confuses integrators.

**Suggested changes:**

- Expose `autoCreatePullRequest` and `systemPrompt` in Settings and `PublicConfig`, or document them explicitly in README if intentionally API-only.
- Keep client `CONFIG_FIELDS` in sync with server `PublicConfig`.

---

### 9. Duplicated code between client and server

`resolve-tool-call-id.ts` is **byte-for-byte identical** in `src/lib/` and `client/src/lib/`. Client and server also maintain **parallel type definitions** (`AppConfig`, agent types) that already drift.

**Why it matters:** Bug fixes must be applied twice; types will keep diverging.

**Suggested changes:**

- Extract shared types/utilities to a small `shared/` package, or generate client types from server OpenAPI/schema.
- At minimum, add a comment linking the duplicate files and a CI check that they stay in sync.

---

## Medium — maintainability and ops

### 10. JSON file persistence without concurrency safety

State lives in `config.json`, `repos.json`, `agents.json` via synchronous read/write (`src/lib/json-store.ts`). Main process and worker child processes both update agent records (`src/domains/agents/worker/agent-state-writer.ts`). No file locking or atomic rename writes.

**Why it matters:** Under concurrent agents or crash mid-write, corruption is possible.

**Suggested changes:**

- Document as a v1 limitation in README/SECURITY, or implement atomic writes (write temp + rename) and optional file locking.

---

### 11. Deprecated shims still exported

- `src/domains/agents/agent.service.ts` — `@deprecated Use createAgentService`
- `src/domains/repos/repo.service.ts` — `@deprecated Use createRepoService`
- `src/integrations/opencode/event-mapper.ts` — deprecated mapper function
- `src/workers/agent-worker.ts` — re-export shim for entrypoint

**Why it matters:** Public repos benefit from clean public APIs; dead aliases confuse new contributors.

**Suggested changes:**

- Remove deprecated exports or schedule removal in a changelog before v1.0.

---

### 12. OpenCode version pinning inconsistency

Dockerfile pins `opencode-ai@v1.15.13`; README says `npm install -g opencode-ai` with no version. Behavior may differ between Docker and local dev.

**Suggested changes:**

- Pin the same version in README and document upgrade policy.

---

### 13. Manual verification scripts undocumented

`scripts/verify-event-mapper.ts`, `verify-tool-call-id.ts`, `verify-transcript-history.ts` are not wired into `package.json` or CI.

**Suggested changes:**

- Add npm scripts or fold into the test suite; mention in CONTRIBUTING.

---

### 14. Large design artifact in repo

`docs/designs.pen` is ~9,750 lines.

**Suggested changes:**

- Consider gitignoring, LFS, or hosting design files outside the main repo if they bloat clones.

---

### 15. `.agents/skills/ponytail-*` in the repo

Six ponytail skills under `.agents/skills/` plus references in `.opencode/opencode.json`. These are **internal agent tooling**, not product features.

**Why it matters:** OSS visitors may think they need ponytail to run the project.

**Suggested changes:**

- Document as maintainer-only dev tooling, or move to a separate repo / `.gitignore`.

---

## Lower — nice to have for OSS maturity

| Item | Notes |
|------|--------|
| **CONTRIBUTING.md** | Listed as TODO in pre-release checklist (PR template too) |
| **SECURITY.md** | Document threat model, how to report issues, deployment guidance |
| **CODE_OF_CONDUCT** | Standard for community projects |
| **`package.json` metadata** | Missing `repository`, `author`, `homepage`, `bugs` |
| **Client tests** | None |
| **Webhook SSRF** | Operator-set `webhookUrl` can POST to internal URLs; document or restrict |
| **Docker metadata tags** | Workflow sets both `latest` and run-number tags — document image tagging policy |

---

## What already looks solid

Worth calling out so the public narrative stays balanced:

- **Secret hygiene:** GitHub keys masked in GET config; `redactSecrets` on error paths.
- **Input validation:** Branch names, repo names, URLs validated in `src/lib/validation.ts`.
- **Factory-based DI:** Services are testable with injected `fs`/`spawn`.
- **Test coverage:** Meaningful unit tests for agent flows, loop config, PR generation, OpenCode config.
- **Docker basics:** Multi-stage build, non-root user, volume-backed data.
- **README API reference:** Thorough curl examples for batch/interactive/loop modes.
- **Production token guard:** Exists when `NODE_ENV=production` (needs Docker alignment).

---

## Suggested pre-release order

1. Add **`LICENSE`**, **`SECURITY.md`**, GitHub App setup guide; remove dev artifacts and personal placeholders.
2. Decide and document the **auth/threat model**; align Docker with production token requirements.
3. Clean **README** (remove internal checklist; add security + setup sections).
4. Add **CI test job**; trim or index internal docs.
5. Expose or document hidden config (`autoCreatePullRequest`, `systemPrompt` in UI); dedupe shared client/server code when practical.

---

## Related docs

- [pre-release-checklist.md](./pre-release-checklist.md) — shorter admin/product checklist
- [architecture-recommendations.md](./architecture-recommendations.md) — internal refactor notes (partially stale)
- [DESIGN.md](./DESIGN.md) — UI/design tokens
