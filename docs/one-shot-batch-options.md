# One-shot batch path: problem and improvement options

**Linear:** DKA-229

Batch mode is localagent-box’s **one-shot** path: a single prompt, one OpenCode session, auto commit/push, no inbox or Finish step. Sometimes the model returns a plan or overview and goes idle without editing files. The host used to mark those runs `completed`; that is now treated as a **failure** when `filesChanged === 0`.

This document lists what we changed and further options to tighten prompt → implementation.

## Root causes

| Cause | What happens |
|-------|----------------|
| **Completion signal** | Batch ended when OpenCode went `busy` → `idle`, not when work landed in git |
| **Instruction conflict** | `AGENTS.md` encouraged “plan first” and `docs/todo.md` before edits |
| **Weak batch framing** | Prompt context did not say idle without file changes fails the run |
| **Model / tool issues** | Gemma thinking mode, missing bash `description`, tool schema failures → prose-only replies (see `docs/lessons.md`) |

## Implemented in DKA-229

1. **Require file changes for batch success** — `resolveBatchCompletionStatus()` in `batch-run-flow.ts` mirrors interactive: `completed` only when `filesChanged > 0`.
2. **Clearer failure message** — “finished without file changes — the model may have returned an overview only”.
3. **Stronger batch prompt** — `BATCH_RUN_CONTEXT_PROMPT` in `runner.ts` tells the model the host fails on zero edits.
4. **Agent instructions** — `AGENTS.md`, `config/opencode-tool-instructions.md`, and per-agent `localagent-instructions.md` stress implement-in-same-run for batch.

## Further options (not all implemented)

### Platform / orchestration

| Option | Effort | Notes |
|--------|--------|-------|
| **Auto-retry on zero changes** | Medium | After idle with `filesChanged === 0`, send one follow-up: “You stopped without editing files. Implement now.” Cap at 1–2 retries to avoid loops. |
| **Tool-use gate** | Medium | Track `tool.start` in `session-orchestrator`; if turn completes with zero tools and zero git changes, fail fast or retry before finalize. |
| **Minimum turn duration** | Low | Ignore idle for N seconds after prompt if no tools fired (reduces instant overview-only exits). |
| **`allowEmptyCompletion` job flag** | Low | Opt-in for rare “answer only” batch jobs; default false. |
| **Structured completion** | High | Require agent to call a `finish` tool with `filesTouched` summary; host validates against git. |

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
| **Surface “no changes” in UI** | Low | Badge or result field when batch fails with `opencodeSuccess` but zero files. |
| **Log tool count on complete** | Low | Append `tool.start` count to agent log at batch end for debugging. |
| **Events API metric** | Medium | Expose `toolsUsed` / `assistantChars` on agent result for automation. |

## Recommended next steps

1. **Ship file-change gate** (done) — biggest lever with smallest diff.
2. **Single auto-retry** — best balance if models still stop after one prose turn.
3. **Tool-use gate + log summary** — helps distinguish “model refused tools” vs “model edited then reverted”.
4. **Batch-specific OpenCode agent** — if instruction stacking still loses to generic `build` behavior.

## Related docs

- `docs/lessons.md` — Gemma, bash schema, SSE idle race
- `docs/agent-session-startup-flow.md` — batch vs interactive lifecycle
- `README.md` — batch = one-shot API default
