# v1 Phase 1 — item 1.0: multi-turn hook in the batch orchestrator

Scope: the batch orchestrator no longer ends at the first turn. When a turn completes
it can call a host hook that decides what to do next; a follow-up is sent on the same
OpenCode session and polling continues. This is the seam items 1.1–1.3 (verification,
repair, completion gate) hang off.

## Steps

1. `onTurnComplete?: (turn: { index, assistantText }) => Promise<{ followUp, model? } | null>`
   on `SessionOrchestratorOptions`. `index` is 0 for the initial task; `assistantText` is
   the assistant text produced since that turn's prompt was sent.

2. At the point that used to return `turn_complete`, the hook is called. Returning null
   (or having no hook) ends the run as before; returning a follow-up sends it and keeps
   polling. `followUp.model` (a model id) is resolved with `buildModelRefFromId`, falling
   back to the run model.

3. `sendTurn(text, model, transcriptText)` is the four-step turn pattern from the removed
   inbox loop: transcript line, `sendPromptAsync`, reset the busy flags, count the turn.
   The initial prompt and every follow-up go through it, so item 2.4 can wrap it. The turn
   boundary is the prompt itself: the counters reset before sending, and `turnCount`
   increments only when the send succeeds.

4. Per-turn assistant text: the event handler records each finalized message into the
   turn state (`resolveTurnAssistantText` joins them, plus text still streaming at turn
   end), and the state resets when the next prompt is sent.

5. The outcome object carries `turns: Array<{ index, assistantText }>` for every exit
   path (`turn_complete`, `cancelled`, `failed`).

6. Test seam: `createRunner` defaults to `createOpenCodeSessionRunner`, so a test can
   supply a fake runner whose `getSessionStatusMap` flips busy → idle. The status poll is
   now separated from the completion check so a transient poll failure cannot be read as
   idle, and a hook error is not swallowed by that catch.

Timeout and cancel behaviour are unchanged.

## Review

- `npm run build` passes and `npm test` passes (192 tests, 14 in
  `session-orchestrator.test.ts`).
- The new test drives the orchestrator with a fake runner and a hook that returns one
  follow-up then null, and asserts: two `sendPromptAsync` calls, two `user` lines in
  `conversation.jsonl`, `turns.length === 2`, and a `turn_complete` outcome. It also
  asserts the follow-up is sent without the `## Context` framing and on `followUp.model`,
  and that the run model is used when the hook gives no model.
- The transcript still records the first turn as the task text without framing; only the
  prompt sent to OpenCode carries it, so the session UI is unchanged.
- Judgement call beyond the brief: `resolveTurnAssistantText` now takes a turn state
  (`messageTexts` + `streamedAssistantText`) instead of a single snapshot, because a turn
  can contain several assistant messages.

# v1 Phase 1 — item 1.2: repair loop

Scope: a failing host-run check sends the model back to work on the same session, up to the
repo's repair budget. The host still decides whether a check passed; the model only fixes.

## Steps

1. `buildRepairPrompt({ attempt, max, failingCheck })` in `worker/verification.ts` builds the
   follow-up text from `formatCommandResultBlock`, with the two constraints the model must not
   cross: do not change the check, do not commit or push.

2. `runBatchJob`'s `onTurnComplete` hook now verifies after **every** turn, not only turn 0:
   `verifying` while the checks run, then either `passed`, `machine_failure`, or a repair
   decision (`repairing` + `repairAttempt` n on the record) that returns the follow-up. The
   repair model is the run model until item 5.1 adds a role model.

3. Machine failures stop immediately (`classifyFailure` rows: timeout, OOM, disk full, missing
   command) and never consume an attempt; a cancelled run is re-read before the checks so a
   repair turn is never sent after cancellation, and the poll loop already refuses to run past
   the timeout.

4. Exhausted attempts leave `verification.state = 'failed'`, and the completion status is
   `needs_attention` (added to `AgentStatus`, `TERMINAL_STATUSES`, `sseLockedStatuses`, the
   client sets and the danger badge). The branch is still committed and pushed, and
   `predecessorAllowsStart` treats `needs_attention && pushed` like `completed && pushed` so a
   follow-up run on the branch can start.

5. `verification.draftPrOnFailure` is resolved from the base config and stored on the record, so
   `canCreatePullRequest` (server and client) can allow a draft PR for `needs_attention` without
   the workspace.

6. `handleWorkerExit` sends `agent.needs_attention` for that status and `agent.failed` for
   `failed_machine`, and opens the draft PR when `draftPrOnFailure` is set.

## Review

- `npm test` (822), `npm run build` and `npx tsc -p client` pass.
- `batch-run-flow.test.ts` drives `runBatchJob` through the 1.0 fake runner with an injected
  `runChecks`: fail → fail → pass completes with three attempts; fail ×3 with max 2 gives
  `needs_attention` after two repair turns; a timeout gives `failed_machine` with no follow-up
  sent; `repairAttempts: 0` sends none at all. The test also asserts the status the record held
  during each check run and the `repairAttempt` recorded before each repair turn.
- `classifyFailure` rows are covered by `verification.test.ts` (1.1); `buildRepairPrompt` has its
  own test for the exact injected text.
- `queue-eligibility.test.ts` covers a `needs_attention` predecessor (pushed → start, not pushed
  → defer), and `agent-pull-request.test.ts` the draft PR gate.
- Assumptions: `repairAttempt` is stored on the record (needed by the 6.1 progress file and the
  UI); `needs_attention` is not retryable in this item — resume is 6.2.

# v1 Phase 1 — item 1.4: honest PR test plan

Scope: the PR's `## Test plan` says what the host actually ran, not what the model claims. The
generation prompt asks for a summary only, and the single exit of `resolvePullRequestContent`
replaces whatever test plan a model or a caller wrote.

## Steps

1. `buildPullRequestGenerationPrompt` asks for `## Summary` only and states never to include a test
   plan, because the host writes that section from its own checks.

2. `buildHostTestPlanSection(verification, status?)` in `lib/agent-pull-request.ts`:
   - no checks configured (`configSource: 'none'`), or checks configured but no attempt recorded, →
     the `⚠️ Unverified` note;
   - otherwise `## Test plan`, then a Check / Command / Result / Attempts table with one row per check
     from the **last** attempt — Result is `✅ passed`, `❌ exit N` or `⏱ timed out`, and Attempts is
     the number of attempts in which that check ran (a check skipped by the stop-at-first-failure rule
     counts only the attempts where it ran);
   - then `Repair attempts: n of max`, where attempt 0 is the task turn so repairs are the attempts
     after it, and the `**Checks still failing — this draft PR needs attention.**` line for
     `needs_attention`. `status` is optional: with no status passed, `state: 'failed'` is read as
     needing attention, which is the status the repair loop reports for it.

3. `stripModelTestPlanSection` removes a model `## Test plan` from the heading to the next `## `
   heading or `---` rule, and `buildPullRequestBodyWithHostTestPlan` puts the host section in front of
   the metadata `---` block. `buildDefaultPullRequestBody` now writes that `---` rule itself, so the
   insertion point is the same shape for every content source.

4. `resolvePullRequestContent` has one exit: the explicit-override branch no longer returns early, so
   override, LLM, assistant summary and default bodies all get the host section.

## Review

- `npm test` (864), `npm run build` and `npx tsc -p client` pass.
- `agent-pull-request.test.ts` covers the unverified cases, a passed run that needed a repair (with the
  Attempts count for a check that only ran on the second attempt), a failing run flagged for attention,
  a timed-out check, and stripping a model-written plan.
- `pr-content-generator.test.ts` covers the prompt rule and every content source (llm, assistant
  summary, default, explicit override) getting the section before the metadata block.
- `agent.service.test.ts` asserts it through `createPullRequest`: the model's checklist is gone from the
  created PR body and the host table is in its place.
- Assumptions: Attempts counts the attempts where a check ran rather than the attempt number; pipes in
  a command are escaped so the table stays readable.
