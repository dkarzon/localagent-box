# v1 Phase 0 — item 0.4: worker, remove the loop path and loop config

Scope: the loop run path, its config files and every reference to it, so batch and
review are the only run shapes left in the worker.

## Steps

1. `worker/workspace-command.ts` — added `formatCommandResultBlock(result, heading)`,
   the shared formatting for a host-run command result (was `loop-check.ts`'s
   `formatCheckResultBlock`); its test moved to `workspace-command.test.ts`.
   `workspace-command.ts` is now the only command runner.
2. Deleted the loop files and their tests, plus `config/loop.default.json`:
   `loop-run-flow`, `loop-agent`, `loop-config`, `loop-handoff`, `loop-model`,
   `loop-check`, `lib/loop-state`, `lib/loop-verb-models`.
3. `session-orchestrator.ts` — removed `startOpenCodeLoopSession` and its types;
   moved `resolveTurnAssistantText` into the batch section (item 1.0 reads it for
   per-turn assistant text). `agent-state-writer.ts` no longer rebuilds loop state
   in `updateAgentRecord`, and the loop event emitters are gone (`loop.*` dropped
   from `AgentEventType`).
4. Removed the remaining references: worker entry branch and status set, spawner
   job fields and loop timeout, `agent.service.ts` loop blocks (timeout fallback,
   `handleWorkerExit`, `createAgent`, `retryAgent`, `restoreOnStartup`),
   `agent.types.ts` (`withLoopFields`, `LOOP_ACTIVE_STATUSES`), validation and DTO
   fields, `runner.ts` prompt mode and `completionMarker`, `opencode-config.ts`
   model collection (still registers the default plus `job.model`), `config-store.ts`
   and `routes/config.ts` loop settings, `types/index.ts` loop types and config keys,
   `repo-config.ts` (`loopContextPrompt`, `checkCommand`).
5. `workspace-setup.ts` — `ensureLocalagentBoxIgnored` and its tests removed, so runs
   no longer edit `.gitignore`.
6. Fixed the tests and fixtures that referenced removed keys.

## Review

- `npm test` (736 tests) and `npm run build` pass; `npx tsc -p client` passes.
- `grep -rni "loop" src config` now returns only unrelated wording (event loop,
  infinite-loop guard, `O(n²) loop`) plus the `AgentMode` union and `runOnModes`
  validation still accepting `loop` — narrowing those is item 0.5, which is also
  where legacy records get their handling.
- `Agent.modelsUsed` was kept: `lib/agent-pull-request.ts` and
  `lib/pr-content-generator.ts` read it. Nothing sets it now; batch runs will once
  per-run verification (Phase 1) records the model used.
- `resolveTurnAssistantText` is exported because it has no caller until item 1.0.
