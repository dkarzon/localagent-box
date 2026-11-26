# One-shot batch path: problem and improvement options

**Linear:** DKA-229

Batch mode is localagent-box's **one-shot** path: a single prompt, one OpenCode session, auto commit/push. A run is one turn, so follow-up work is a new batch run on the same branch. Sometimes the model returns a plan or overview and goes idle without editing files. The host used to mark those runs `completed`; that is now treated as a **failure** when `filesChanged === 0`, unless the model explains itself (v1 1.3, below).

This document lists what we changed and further options to tighten prompt → implementation.

## Root causes

| Cause | What happens |
|-------|----------------|
| **Completion signal** | Batch ended when OpenCode went `busy` → `idle`, not when work landed in git |
| **Instruction conflict** | `AGENTS.md` encouraged “plan first” and `docs/todo.md` before edits |
| **Weak batch framing** | Prompt context did not say idle without file changes fails the run |
| **Model / tool issues** | Gemma thinking mode, missing bash `description`, tool schema failures → prose-only replies (see `docs/lessons.md`) |

## Implemented in DKA-229

1. **Require file changes for batch success** — `resolveBatchCompletionStatus()` in `batch-run-flow.ts`: `completed` only when `filesChanged > 0`.
2. **Clearer failure message** — “finished without file changes — the model may have returned an overview only”.
3. **Stronger batch prompt** — `BATCH_RUN_CONTEXT_PROMPT` in `runner.ts` tells the model the host fails on zero edits.
4. **Agent instructions** — `AGENTS.md`, `config/opencode-tool-instructions.md`, and per-agent `localagent-instructions.md` stress implement-in-same-run for batch.
5. **Completion gate for zero-change runs** (v1 1.3) — an idle turn with `filesChanged === 0` earns one follow-up: implement now, or explain why nothing was needed. If the second turn still changed nothing, the host reads `.localagent-box/artefacts/no-change.json`, validates it against the `NoChangeExplanation` schema, and completes with `result.noChange: true` — no commit, no push, no PR. Missing or invalid explanation fails the run. `canCreatePullRequest` is false when `result.noChange`.

## Further options (not all implemented)

### Platform / orchestration

| Option | Effort | Notes |
|--------|--------|-------|
| **Auto-retry on zero changes** | Medium | **Done (v1 1.3)** — the completion gate sends one follow-up after an idle turn with `filesChanged === 0`, capped at one per run. |
| **Tool-use gate** | Medium | Track `tool.start` in `session-orchestrator`; if turn completes with zero tools and zero git changes, fail fast or retry before finalize. |
| **Minimum turn duration** | Low | Ignore idle for N seconds after prompt if no tools fired (reduces instant overview-only exits). |
| **`allowEmptyCompletion` job flag** | Low | Opt-in for rare “answer only” batch jobs; default false. |
| **Structured completion** | High | **Done (v1 1.3)** — `no-change.json` is the structured completion for zero-change runs, host-validated against the schema. The host still decides, not the model. |

### Prompts and config

| Option | Effort | Notes |
|--------|--------|-------|
| **Per-job `systemPrompt` in opencode.json** | Low | Today per-agent prompt is only in the prompt body; merge into `localagent-instructions.md` for stronger steering. |
| **Dedicated OpenCode agent profile** | Medium | Custom `build-batch` agent in opencode config with stricter system prompt than generic `build`. |
| **Shorter AGENTS.md for batch** | Medium | Inject batch-specific instruction file instead of full repo `AGENTS.md` when `mode === 'batch'`. |
| **Prepend “implementation required”** | Low | Repeat one line in user prompt for small/local models. |

### Model and tooling

| Option | Effort | Notes |
|--------|--------|-------|
| **Model allowlist / warnings** | Low | UI/API warning when selected model is known weak (Gemma 4 without workaround, tiny models). |
| **Default model tuning** | Low | Document minimum capable models for one-shot batch in README. |
| **Bash `description` enforcement** | Done | `opencode-tool-instructions.md` + Gemma `reasoning_effort` workaround in `opencode-config.ts`. |

### Observability and UX

| Option | Effort | Notes |
|--------|--------|-------|
| **Surface “no changes” in UI** | Low | **Done (v1 1.3)** — the session info panel shows the accepted explanation with its reason and evidence. |
| **Log tool count on complete** | Low | Append `tool.start` count to agent log at batch end for debugging. |
| **Events API metric** | Medium | Expose `toolsUsed` / `assistantChars` on agent result for automation. |

## Recommended next steps

1. **Ship file-change gate** (done) — biggest lever with smallest diff.
2. **Single auto-retry** — shipped (v1 1.3 completion gate).
3. **Tool-use gate + log summary** — helps distinguish “model refused tools” vs “model edited then reverted”.
4. **Batch-specific OpenCode agent** — if instruction stacking still loses to generic `build` behavior.

## Related docs

- `docs/lessons.md` — Gemma, bash schema, SSE idle race
- `README.md` — batch = one-shot API default
