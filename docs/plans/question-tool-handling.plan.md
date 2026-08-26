# Question tool handling in unattended modes

**Linear:** DKA-316

When an OpenCode agent invokes the built-in `question` tool during **loop** or **batch** mode, the session can hang until the global agent timeout. There is no user in the loop to answer. This document records root-cause analysis and recommended fixes. **No code changes are included here** — implementation is a follow-up.

**Related:** `src/integrations/opencode/session-orchestrator.ts`, `src/integrations/opencode/session-runner.ts`, `src/services/opencode-config.ts`, `docs/opencodeapi.json`, `docs/one-shot-batch-options.md`

---

## Problem

In loop mode (and batch mode), turn completion is detected by polling OpenCode session status until the session goes **idle** after having been **busy** (`isBatchTurnComplete` in `session-runner.ts`). If the model calls the `question` tool, OpenCode blocks the turn waiting for a human answer. The session typically stays `busy`, so the host polls forever (until `agentTimeoutMs`).

Symptoms:

- Loop step or batch run appears stuck with no further log output.
- UI may show a `question` tool call in `pending` / `running` state.
- Run eventually fails with a session timeout, not a clear “waiting for user” error.

Interactive mode is intentionally user-driven; this issue targets **unattended** modes only.

---

## Root cause

OpenCode exposes **two separate mechanisms** that localagent-box treats differently today:

| Mechanism | SSE event | Host API | Handled today? |
|-----------|-----------|----------|----------------|
| **Permissions** (bash, edit, etc.) | `permission.asked` | `POST /permission/{id}/reply` | Yes — `replyPermission('once')` when `autoApprovePermissions` is true (batch/loop default) |
| **Question tool** | `question.asked` | `POST /question/{id}/reply` or `…/reject` | **No** |

The question subsystem is documented in `docs/opencodeapi.json`:

- `GET /question` — list pending question requests
- `POST /question/{requestID}/reply` — body `{ answers: string[][] }` (one inner array per question; each inner array holds selected option labels)
- `POST /question/{requestID}/reject` — reject without answers
- SSE: `question.asked`, `question.replied`, `question.rejected`

`PermissionConfig` includes a `question` key, but that only controls whether the agent **may invoke** the tool (`ask` / `allow` / `deny`). Setting `permission: { '*': { '*': 'allow' } }` (current auto-approve path in `opencode-config.ts`) does **not** supply answers. The tool still waits for `reply` or `reject`.

Current unattended prompt text (`BATCH_RUN_CONTEXT_PROMPT`, `LOOP_RUN_CONTEXT_PROMPT`, `config/opencode-tool-instructions.md`) says runs are unattended but does **not** explicitly forbid the `question` tool. Models trained on interactive assistants (or Cursor-style flows) may still call it when requirements are ambiguous.

### Where the hang occurs

```
Model calls question tool
  → OpenCode emits question.asked
  → Session status stays busy
  → session-orchestrator runTurn / batch poll loop
  → isBatchTurnComplete never true
  → Hang until agentTimeoutMs
```

Relevant code paths:

- Batch: `runSessionOrchestrator` → `handleOpenCodeEvent` (permissions only) → idle poll loop (~line 584–605)
- Loop: `startOpenCodeLoopSession` → same handler → `runTurn` idle poll (~line 989–1004)
- Event mapper: maps `permission.*` to `permission.requested`; **does not** handle `question.*`

---

## Design goals

1. **Unattended by default** — loop and batch must not block on user input.
2. **Minimal surprise** — if the model “asks,” the host should respond deterministically (reject or synthetic answer), not silently time out.
3. **Interactive unchanged** — optional future work to surface questions in the UI; out of scope for DKA-316.
4. **Mirror permissions pattern** — same configuration surface (`autoApprovePermissions` or a sibling flag) where possible.

---

## Solution options

### Option A — Disable the `question` tool in OpenCode config (recommended primary)

OpenCode `Config` supports:

```json
{
  "tools": { "question": false }
}
```

Per-agent override is also available via `agent.build.tools` / `mode.build.tools` (`AgentConfig.tools` in the OpenAPI schema).

**Implementation sketch**

- Extend `buildOpenCodeConfig` / `OpenCodeConfigBuildOptions` with `runMode: 'batch' | 'loop' | 'interactive'` (or `disableQuestionTool?: boolean`).
- For batch and loop, set `tools: { question: false }` on the per-agent `opencode.json` written under `{dataDir}/agents/{agentId}/opencode-config/`.
- Leave interactive unchanged (tool remains available for a future UI bridge).

**Pros**

- Prevents the hang at the source; no runtime polling or SSE handling required.
- Smallest ongoing maintenance; aligns with “unattended = no user tools.”

**Cons**

- Model cannot use `question` even when a structured choice might help (rare in batch/loop).
- If the model retries the call, OpenCode may surface a tool error — usually acceptable.

**Effort:** Low (~`opencode-config.ts`, call sites in `session-orchestrator.ts`, one unit test).

---

### Option B — Auto-reject pending questions (recommended secondary / belt-and-suspenders)

Mirror `replyPermission` with `rejectQuestion(requestId)` on `OpenCodeSessionRunner`:

```ts
async function rejectQuestion(requestId: string): Promise<void> {
  await fetch(`${baseUrl}/question/${encodeURIComponent(requestId)}/reject`, {
    method: 'POST',
  });
}
```

In `handleOpenCodeEvent`, when `ocEvent.type === 'question.asked'` and mode is unattended:

```ts
if (ocEvent.type === 'question.asked' && unattended) {
  const requestId = ocEvent.properties.id;
  void sessionRunner.rejectQuestion(requestId);
}
```

Log: `OpenCode question auto-rejected: {requestId}` and emit a new agent event type (e.g. `question.auto_rejected`) for observability.

**Pros**

- Unblocks the session if the tool is still callable (config drift, OpenCode version change, per-agent override).
- Clear signal to the model: “no user here — continue with assumptions.”

**Cons**

- Model may re-ask or waste a turn; may need prompt reinforcement (Option D).
- Reject payload semantics should be verified against the pinned OpenCode version.

**Effort:** Low–medium (`session-runner.ts`, `session-orchestrator.ts`, `event-mapper.ts` optional mapping, tests with mocked SSE).

---

### Option C — Auto-answer with synthetic responses

On `question.asked`, call `POST /question/{id}/reply` with constructed answers:

| Question shape | Suggested auto-answer |
|----------------|----------------------|
| Single-choice options | First option’s `label` |
| Multiple-choice | First option only (or all if `multiple: true` and policy says “proceed”) |
| `custom: true` | Fixed string: `"No user available. Use your best judgment and continue without asking."` |

Example body for one question with options `[{label:"A",...},{label:"B",...}]`:

```json
{ "answers": [["A"]] }
```

**Pros**

- Model receives a “normal” tool result; may continue more smoothly than after reject.

**Cons**

- **Wrong answers** can steer implementation (dangerous for ACT steps).
- More logic (parse `QuestionInfo`, handle `multiple` / `custom`).
- Hard to make policy obvious to operators.

**Recommendation:** Use only if product wants “always pick first option” behavior; otherwise prefer reject (Option B). If implemented, gate behind config, e.g. `questionAutoReply: 'reject' | 'first_option' | 'custom_text'`.

**Effort:** Medium.

---

### Option D — Prompt / instruction hardening (cheap, not sufficient alone)

Add explicit guidance to unattended surfaces:

- `BATCH_RUN_CONTEXT_PROMPT` / `LOOP_RUN_CONTEXT_PROMPT` in `runner.ts`
- `config/opencode-tool-instructions.md` (bundled into `localagent-instructions.md`)
- Optional repo override docs in `docs/repo-config.md`

Example line:

> **No user is available.** Do not call the `question` tool. If requirements are ambiguous, choose the simplest reasonable interpretation, document assumptions in your summary, and continue.

**Pros:** Zero OpenCode API coupling; helps regardless of config.

**Cons:** Not reliable for smaller or instruction-resistant models; does not fix hang by itself.

**Effort:** Low.

**Recommendation:** Do alongside A or B, not instead of them.

---

### Option E — Poll `GET /question` during turn wait (safety net)

During the `runTurn` / batch idle poll, if session is busy for longer than N seconds:

1. `GET /question`
2. For each pending request for this `sessionID`, apply Option B or C.

**Pros:** Catches missed SSE events or race conditions.

**Cons:** Extra HTTP traffic; need threshold to avoid flapping.

**Effort:** Low if B/C already exist.

---

### Option F — Interactive UI bridge (out of scope for DKA-316)

For `mode === 'interactive'`:

- Map `question.asked` to a new client event.
- Render questions in `AgentSessionInfo` / transcript.
- POST user answers through a new localagent-box API that proxies to OpenCode `reply`.

Valuable for parity with OpenCode TUI, but does not solve unattended loop/batch.

**Effort:** High (API, UI, state machine).

---

## Recommended approach

**Ship a layered fix for batch + loop:**

| Layer | Action | Priority |
|-------|--------|----------|
| 1 | **Option A** — `tools.question: false` in per-agent `opencode.json` for batch/loop | P0 |
| 2 | **Option B** — auto-reject on `question.asked` when unattended (covers config gaps) | P1 |
| 3 | **Option D** — explicit “never use question tool” in prompts / tool instructions | P1 |
| 4 | **Option E** — optional poll fallback after e.g. 30s busy with pending question | P2 |

Avoid Option C unless product explicitly wants guessed answers.

### Configuration

Extend Settings alongside existing permission toggles:

| Setting | Default | Scope |
|---------|---------|-------|
| `batchAutoApprovePermissions` | `true` | existing |
| `loopAutoApprovePermissions` | `true` | existing |
| `batchDisableQuestionTool` | `true` | new (or derive from mode) |
| `loopDisableQuestionTool` | `true` | new |
| `batchAutoRejectQuestions` | `true` | new — only if tool not disabled |
| `loopAutoRejectQuestions` | `true` | new |

Alternatively, fold question handling into a single **“unattended mode”** preset that disables the tool and auto-rejects, to avoid settings sprawl.

Interactive: no change initially; document that `question` is unsupported in the web UI until Option F.

---

## Implementation checklist (follow-up PR)

### Server

1. **`src/services/opencode-config.ts`**
   - Add `tools: { question: false }` when building config for unattended modes.
   - Pass `runMode` or `disableQuestionTool` from orchestrator.

2. **`src/integrations/opencode/session-runner.ts`**
   - Add `rejectQuestion(requestId)` and optionally `replyQuestion(requestId, answers)`.
   - Add `listPendingQuestions(): Promise<QuestionRequest[]>` for Option E.

3. **`src/integrations/opencode/session-orchestrator.ts`**
   - In `handleOpenCodeEvent` (batch + loop handlers), handle `question.asked` like permissions.
   - Factor shared `handleUnattendedOpenCodeEvent(ocEvent, { autoApprovePermissions, autoRejectQuestions })` to avoid duplication between `runSessionOrchestrator` and `startOpenCodeLoopSession`.

4. **`src/integrations/opencode/event-mapper.ts`** (optional)
   - Map `question.asked` → `question.requested` for SSE clients / logs.

5. **`src/integrations/opencode/runner.ts`** + **`config/opencode-tool-instructions.md`**
   - Option D prompt lines.

6. **Tests**
   - Unit: `buildOpenCodeConfig` includes `tools.question: false` for batch/loop.
   - Unit: SSE handler calls `rejectQuestion` on `question.asked`.
   - Integration-style: mock session runner; assert `runTurn` completes after synthetic `question.asked` + reject (session transitions busy → idle).

### Client / docs

- README: note that batch/loop disable or auto-reject the question tool.
- Settings (optional): expose toggles if not hard-coded.

---

## Verification plan

1. **Repro (before fix):** Start a loop agent with a prompt that encourages clarification (“ask me which database to use”). Confirm hang and `question` tool in pending state.
2. **After Option A:** Same prompt — model should not invoke `question` (tool unavailable) or get immediate tool error; turn completes.
3. **After Option B:** Temporarily leave tool enabled; confirm `question.asked` logs auto-reject and step completes within one poll cycle.
4. **Regression:** Batch and loop runs with normal coding tasks unchanged; permission auto-approve still works.
5. **Timeout:** Unattended run should not sit at full `agentTimeoutMs` solely due to an unanswered question.

---

## Risks and open questions

| Topic | Notes |
|-------|--------|
| OpenCode version drift | Question API is tagged `question` in OpenAPI; pin behavior against the same version as `docs/opencodeapi.json` (currently bundled for 1.0.218 per `session-runner.ts` comment). |
| Reject vs reply semantics | Confirm what the model sees after `reject` — may need one retry-tolerant prompt line. |
| Plan agent (`read-only`) | ORIENT/REFLECT use `plan` agent; if it questions, same hang applies — fix must cover all loop verbs. |
| `GET /question` shape | Verify list response schema when implementing Option E. |

---

## Summary

The hang is caused by an **unhandled OpenCode question flow**, not by the existing permission auto-approve path. The lowest-risk fix is to **disable `question` in per-agent OpenCode config for batch/loop**, plus **auto-reject** as a runtime safety net and **clearer prompts** so models default to assumptions instead of blocking. Interactive question UI remains a separate enhancement.
