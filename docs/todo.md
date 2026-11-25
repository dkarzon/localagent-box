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
