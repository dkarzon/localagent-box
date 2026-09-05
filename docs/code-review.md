# Code review mode (Open Code Review)

localagent-box can run **pull request code reviews** using [Open Code Review (OCR)](https://alibaba.github.io/open-code-review/#/docs) — a CLI that diffs two branches, reviews changed files with your LLM, and returns structured findings.

Review runs are a fourth agent **mode** (`review`). They reuse the same clone/checkout workspace pipeline as coding agents, but the worker runs `ocr review` instead of OpenCode. Results are stored on the review session and, when a matching GitHub PR exists, posted as a PR review (summary plus line and file comments).

The Docker image and local dev setup install OCR globally as the `ocr` binary (`@alibaba-group/open-code-review`).

## How it works

```
Clone repo → checkout head branch → ocr review (base..head) → save JSON → post GitHub PR review
```

1. **Workspace** — shallow clone, fetch, checkout `headBranch` (same as coding agents with `useExistingBranch`).
2. **OCR** — `ocr review --repo <workspace> --from <baseBranch> --to <headBranch> --format json --audience agent`, with optional `-b <background>` context.
3. **Persist** — `review-result.json` and optional `review-session.json` under `{DATA_DIR}/agents/{agentId}/`.
4. **GitHub** — if a PR exists for `headBranch`, post a `COMMENT` review with a markdown summary; line comments and file-level comments are attached when OCR returns them.

OCR uses the same Ollama endpoint as coding agents. The model is `reviewModel` from Settings when set, otherwise `opencodeModel`.

## Enabling reviews

### Global Settings

In the UI (**Settings → Pull requests & review**) or via `PUT /api/v1/config`:

| Field | Default | Purpose |
|-------|---------|---------|
| `autoReviewPullRequests` | `false` | After a coding agent creates a PR, automatically queue a review agent for that branch pair |
| `reviewModel` | — | Model for OCR; falls back to `opencodeModel` when empty |

`ollamaBaseUrl` must be configured and reachable — OCR cannot run without it.

### Per-repository override

On **Repositories**, each repo has an **Auto-review PRs** tri-state: inherit global / on / off.

API:

```bash
curl -X PUT http://localhost:8080/api/v1/repos/your-org-your-repo \
  -H "Authorization: Bearer <API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"autoReviewPullRequests": true}'
```

Use `null` to inherit the global default, `true` to force on, `false` to force off.

## Triggers

| Trigger | When |
|---------|------|
| **Auto-spawn** | Coding agent completes, branch was pushed, PR is created (manual or `autoCreatePullRequest`), and `autoReviewPullRequests` resolves to enabled for that repo |
| **UI shortcut** | **Review branches** on a completed, pushed coding session (same `baseBranch` / `headBranch`) |
| **New review session** | Agent sessions page — create `mode: review` with branch range |
| **API** | `POST /api/v1/agents` with `"mode": "review"` |

Auto-spawn skips when:

- A review for the same parent + PR head SHA already exists
- A review for the same `baseBranch`..`headBranch` pair is already queued or running
- Another coding session is still active on the head branch

Manual and API-triggered reviews always run (no SHA dedup).

## API example

```bash
curl -X POST http://localhost:8080/api/v1/agents \
  -H "Authorization: Bearer <API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "repoId": "your-org-your-repo",
    "mode": "review",
    "baseBranch": "main",
    "headBranch": "agent/task-42",
    "background": "Focus on security and input validation.",
    "parentAgentId": "<optional-parent-agent-id>"
  }'
```

Review-specific create fields:

| Field | Description |
|-------|-------------|
| `headBranch` | Branch to review (required) — checked out in the workspace |
| `baseBranch` | Diff base (default: repo `defaultBranch` or `main`) |
| `background` | Optional extra context passed to OCR (`-b`) |
| `parentAgentId` | Links review to a coding session; used for UI and auto-spawn dedup |
| `prompt` | Optional; usually empty for reviews |

`push` defaults to `false`; review agents do not commit. `useExistingBranch` is forced to `true` for review mode.

Poll `GET /api/v1/agents/<reviewAgentId>` — `agent.review` includes `baseBranch`, `headBranch`, `prNumber`, `headSha`, `githubReviewId`, and `ocrResultPath`.

## Review background context

OCR receives a merged **background** string built from:

1. **Repo preamble** — `reviewBackground` in `.localagent-box/config.json` (see [repo-config.md](./repo-config.md))
2. **Caller `background`** on create (API or UI)
3. **Parent context** — when `parentAgentId` is set: parent task + transcript summary (auto-spawn fills this from the coding session)

## Autofix (review findings)

Completed reviews persist structured findings and, when the repository has autofix enabled, automatically fix findings at or above the configured severity threshold. Orchestration stays on the host; fix agents are ordinary batch agents (`useExistingBranch: true`) that never touch GitHub.

### Repository settings

Each repository (see **Repositories**) configures:

| Setting | Default | Purpose |
|---------|---------|---------|
| `autofix.severityThreshold` | `disabled` | Lowest severity fixed automatically (`disabled`/`critical`/`high`/`medium`/`low`, inclusive) |
| `autofix.maxFindingsPerBatch` | `5` | Findings per fix agent, 1–20 |

Settings are snapshotted into the review's autofix plan at review completion; later settings changes affect future reviews only. Unknown severities are never automatic but stay manually fixable.

### Findings and plan storage

- `review-findings.json` — one record per OCR finding: severity, category, path/lines, content, OCR code suggestions, reviewed SHA, fix status (`available`/`assigned`/`fixing`/`fixed`/`failed`), assigned agent, and GitHub comment/thread/resolution state.
- `review-autofix-plan.json` — the orchestration state: settings snapshot, sequential batch list, chain status (`disabled`/`running`/`paused`/`completed`), and the verification-review slot. Writes are atomic.

### Automatic chain

Eligible findings are sorted by severity (OCR order within a severity), split into batches of `maxFindingsPerBatch`, and processed one batch agent at a time:

1. The review creates the first batch agent when it completes.
2. A successful push marks the batch's findings fixed, resolves their GitHub threads (host-side), and creates the next batch.
3. A failure, cancellation, or finish without a push pauses the chain and leaves the failed batch's findings manually fixable.
4. **Resume Remaining Batches** (UI or API) skips the failed batch and creates the next pending one.
5. After the last successful batch, exactly one autofix-ineligible verification review is created. Verification reviews can never start another chain; their findings still allow individual Manual Fix.

Manual fixes of single findings (below-threshold, unknown severity, stale, no PR) coalesce into one verification review after all related fix agents on the branch drain.

### API

| Endpoint | Purpose |
|----------|---------|
| `GET /api/v1/agents/:reviewAgentId/findings` | Structured findings, autofix plan, staleness, verification link |
| `POST /api/v1/agents/:reviewAgentId/findings/:findingId/fix` | Create a one-finding manual fix agent (conflicts while assigned) |
| `POST /api/v1/agents/:reviewAgentId/autofix/resume` | Resume a paused chain (skips failed batches; `DUPLICATE` on conflict) |
| `POST /api/v1/agents/:reviewAgentId/findings/:findingId/retry-resolution` | Retry GitHub thread resolution (never creates an agent) |

### Restart reconciliation

On startup the host reconciles every persisted plan without creating agents: a queued fix agent is retained and re-enqueued (its chain stays `running`), a batch whose agent record is missing or was interrupted is failed with the chain `paused`, and its findings become manually actionable. Never creates duplicate fix agents. Orchestration emits structured `autofix.*` logs (review ID, batch index, finding IDs, fix agent ID).

### GitHub permissions

Thread resolution uses the GraphQL `resolveReviewThread` mutation, so the GitHub App needs **Pull requests: Read and write** (REST review/comment posting) plus GraphQL access with the installation token. Resolution failures never change the fix agent's coding result; the finding stays retryable.

## GitHub output

When a PR matches `headBranch`:

- **Summary** — markdown body on the PR review (`formatReviewSummaryMarkdown`), including a **Severity & categories** breakdown table
- **Line comments** — inline on changed lines when OCR returns path/line data; each comment body leads with severity and category badges (e.g. `🔴 **critical** · 🔒 Security`)
- **File comments** — file-level notes when OCR returns file-scoped findings without line numbers (same badges)

OCR classifies every finding with a `category` (`bug`, `security`, `performance`, `maintainability`, `test`, `style`, `documentation`, `other`) and a `severity` (`critical`, `high`, `medium`, `low`). These are surfaced in:

- The review headline (severity counts, e.g. `🔍 **3 finding(s)** — critical: 1, medium: 2`)
- A `### Severity & categories` table in both the session view and the PR summary
- The `### Findings` list, sorted critical → low
- Each GitHub line/file comment body

If line comments fail (e.g. stale diff), the worker retries with summary-only. If GitHub posting fails entirely, the review session still completes with `result.warning` in logs.

If no PR exists for the head branch, OCR still runs and results are saved locally; GitHub posting is skipped.

## Failure semantics

| Outcome | Agent status | Notes |
|---------|--------------|-------|
| OCR CLI fails | `failed` | Error in `agent.error` and logs |
| OCR succeeds, GitHub post fails | `completed` | `result.warning` describes the GitHub error |
| OCR succeeds, no matching PR | `completed` | Results stored; log notes skipped GitHub post |

Review agents do not support follow-up messages or **Finish** — they are single-shot.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `OCR_BIN` | `ocr` | OCR CLI binary (preinstalled in Docker image) |
| `OCR_REVIEW_TIMEOUT` | `30` | Per-file review deadline in minutes (`0` disables). OCR's own default is 10. |
| `OCR_LLM_TIMEOUT` | `600` | Per-request LLM HTTP timeout in seconds. OCR's own default is 300. |
| `OCR_REVIEW_CONCURRENCY` | `8` | Max file groups reviewed in parallel. Lower this when using a local LLM (e.g. Ollama) to reduce timeouts. |

OCR LLM URL, token, and model are derived from server config at runtime (`OCR_LLM_URL`, `OCR_LLM_MODEL`, etc.) — you do not set those manually when using Ollama.

## Local development

Install OCR alongside OpenCode:

```bash
npm install -g @alibaba-group/open-code-review@v1.9.6
```

Match the version pinned in the [Dockerfile](../Dockerfile). Ensure `ocr` is on `PATH` (or set `OCR_BIN`).

## Related

- [github-app-setup.md](./github-app-setup.md) — GitHub App needs pull request read/write for posting reviews
- [repo-config.md](./repo-config.md) — per-repo `reviewBackground`
- [README.md](../README.md) — full API reference and agent modes
