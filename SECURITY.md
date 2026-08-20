# Security Policy

## Threat model

**localagent-box is designed to run on a trusted local network, not the public internet.**

It is a self-hosted daemon that gives coding agents access to your GitHub repositories, a GitHub App private key, and (optionally) an Ollama endpoint. The server binds to `0.0.0.0` on port `8080` by default and assumes the network it's attached to is already trusted — e.g. a home LAN, a VPN, or a single-tenant internal network. It is **not** hardened for exposure to untrusted networks or the internet.

If you deploy localagent-box anywhere other than a trusted local network, you are responsible for adding the additional controls described in [Hardening recommendations](#hardening-recommendations) below (reverse proxy with real auth, network policy, TLS, etc.).

## Known deviations from a "secure by default" service

These are current, intentional (or at least documented) trade-offs, not necessarily bugs. Understanding them is the point of this document.

### 1. Reads are unauthenticated by design

Bearer token auth (`Authorization: Bearer <API_TOKEN>`, checked in `src/lib/http.ts`) is enforced on **mutating** endpoints (create/finish/delete agents, config writes, repo writes, GitHub verification). Most **`GET` endpoints are intentionally open**, including:

- `GET /api/v1/config` — returns Ollama URL, GitHub App ID/installation ID, webhook URL, and other settings (the GitHub App private key is masked as `***`)
- `GET /api/v1/agents`, `GET /api/v1/agents/:id` — agent metadata, prompts, branches
- `GET /api/v1/agents/:id/logs`, `/messages`, `/events` (SSE) — full transcripts and tool output
- `GET /api/v1/agents/:id/git-status`, `/pull-request` — changed files, PR state
- `GET /api/v1/repos`, `/api/v1/repos/:id` — registered repository metadata

This is done so the UI works without embedding the token in every request, and specifically so Server-Sent Events (`/agents/:id/events`) work at all — the browser `EventSource` API cannot send custom headers, so there is no way to require a Bearer token on that route without a separate ticket/session mechanism (not yet implemented).

**Implication:** anyone who can reach the port can read every agent's prompts, code, logs, and repo metadata without a token. Agent IDs are 12 hex characters and are not designed to be secret. Do not rely on ID guessability as a control.

### 2. The default API token ships everywhere

`API_TOKEN` defaults to `localagent-box` in the Dockerfile, `docker-compose.yml`, the bundled UI, and the README. The server only refuses to start with the default token when `NODE_ENV=production` is set — the Docker image does **not** set `NODE_ENV`, so a default container will happily boot with the default token.

**Action required:** always set a non-default `API_TOKEN` (and ideally `NODE_ENV=production`) when running this outside of a quick local test.

### 3. Secrets are stored in plaintext on disk

`config.json`, `repos.json`, and `agents.json` under `DATA_DIR` (default `/data`) are plain JSON files written with `fs.writeFileSync`, no encryption at rest and no file locking. This includes the GitHub App private key (PEM), which is stored in full and only masked (`***`) when returned from `GET /api/v1/config` — it is not encrypted on disk.

**Implication:** anyone with filesystem or volume access to `DATA_DIR` can read the PEM, GitHub App IDs, and any configured webhook URL in plaintext. Protect the data volume with the same care you'd give an SSH private key.

### 4. Agents run with full workspace filesystem access, no sandboxing

Each agent run is a child Node process (spawned via `worker-spawner.ts`) that clones the target repository into a workspace directory and executes OpenCode with the configured model/provider. There is no per-agent container, chroot, seccomp profile, or network isolation — the worker inherits the host process environment and can read/write anything the host user can, within its workspace. Tool-call auto-approval defaults to **on** for batch and loop modes.

**Implication:** only point this at repositories and prompts you trust, on a host you're comfortable letting an LLM-driven process operate on. Treat it the same as giving a script write access to a checkout of your code — because that's what it is.

### 5. Outbound webhook URLs are not restricted (SSRF)

If you configure `webhookUrl`, localagent-box will `POST` a JSON payload to it whenever an agent finishes. The only validation is that the URL is `http://` or `https://` (`src/lib/webhook.ts`) — there is no blocklist for internal/link-local addresses (e.g. `169.254.169.254`, `host.docker.internal`, RFC1918 ranges). A misconfigured or malicious `webhookUrl` can be used to probe or hit internal services reachable from the container/host.

**Implication:** only set `webhookUrl` to an endpoint you control, and be aware that anyone with access to the mutating config API can point it anywhere on the reachable network.

### 6. No inbound GitHub webhook signature verification

There is currently no inbound `/webhooks/github` endpoint at all, so there's nothing to spoof today — this is called out here only so it's not assumed to exist. If an inbound webhook receiver is added in the future, it must verify the `X-Hub-Signature-256` HMAC before trusting the payload.

### 7. No rate limiting, CORS policy, or security headers

The HTTP layer does not set `Content-Security-Policy`, `X-Frame-Options`, or similar headers, has no CORS restrictions, and has no request rate limiting beyond a 5 MB request body cap. This is consistent with a same-host/trusted-LAN deployment and is not intended to withstand hostile traffic.

## What is already in place

- Mutating API routes require an exact `Authorization: Bearer <token>` match.
- Startup fails outright if `NODE_ENV=production` and `API_TOKEN` is still the default (see caveat above about Docker not setting `NODE_ENV`).
- The GitHub App private key is redacted (`***`) in all API responses; only a `hasGithubAppPrivateKey` boolean is exposed.
- Error paths run output through a `redactSecrets` helper (e.g. masking `x-access-token:***@` in authenticated clone URLs) before logging.
- Repository owner/name, branch names, and repository URLs are validated (`src/lib/validation.ts`) — branch names reject shell metacharacters, repo URLs are restricted to `https://github.com/...`.
- Docker image runs as a non-root `node` user.
- Graceful shutdown on `SIGTERM`/`SIGINT`.

## Hardening recommendations

If you need to run localagent-box somewhere more exposed than a trusted local network, at minimum:

1. **Never expose port 8080 directly to the internet.** Put it behind a reverse proxy (nginx, Caddy, Traefik) that terminates TLS and adds a second layer of authentication (e.g. HTTP basic auth, an IP allowlist, or a VPN/SSH tunnel).
2. **Always set a strong, non-default `API_TOKEN`**, and set `NODE_ENV=production` so the startup guard is active.
3. **Restrict network egress** from the host/container if possible, to reduce the impact of the `webhookUrl` SSRF surface and any prompt-injection-driven tool calls that try to reach unexpected hosts.
4. **Protect the `DATA_DIR` volume** (filesystem permissions, disk encryption, backup handling) since it holds your GitHub App private key and full agent transcripts in plaintext.
5. **Scope the GitHub App's permissions to the minimum needed** (contents, pull requests) rather than installing it with broad org-wide access.
6. **Treat every registered repository and configured prompt as something an autonomous process will act on with full write/commit/push access.** Don't point it at repositories you don't trust an automated agent to modify.
7. **Don't rely on agent ID secrecy.** The 12-character hex IDs are identifiers, not capability tokens.

## Reporting a vulnerability

This is currently a solo-maintained project without a dedicated security mailing list. If you find a security issue:

- Prefer opening a private report via the repository's GitHub Security Advisories tab ("Report a vulnerability" under the Security tab), if enabled.
- Otherwise, open an issue that avoids exploit details in the public body and ask for a private channel to share specifics.

Please do not open a public issue with a working exploit against a live deployment. Given the threat model above (trusted local network, no promise of hardened multi-tenant security), most reports will be triaged as "expected behavior for a local tool, needs clearer documentation" vs. "genuine vulnerability" — but SSRF-adjacent, auth-bypass, or remote-code-execution-beyond-the-documented-agent-model issues are all in scope and appreciated.
