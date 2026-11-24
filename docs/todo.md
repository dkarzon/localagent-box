# v1 Phase 0 — item 0.5: narrow the mode union, warn on legacy config, protect legacy records

Scope: `AgentMode` becomes `batch | review` with the removed modes kept only as
`LegacyAgentMode` for pre-v1 records; legacy config keys and legacy repo-config keys
are dropped with a warning instead of being accepted or rewritten; legacy agent records
are closed out at startup and cannot be actioned.

## Steps

1. Single source of truth in `types/index.ts`: `AgentMode = 'batch' | 'review'` and
   `LegacyAgentMode = 'interactive' | 'loop'`. `Agent.mode` and `CreateAgentResponse.mode`
   accept both; `AgentJob.mode` stays `AgentMode`. `lib/validation.ts` imports the type
   instead of redeclaring it, and `AgentStatus`'s `awaiting_input` is commented as legacy only.

2. `validateAgentMode`: `batch`/`review` accepted (null or empty means `batch`);
   `interactive`/`loop` throw `mode "<x>" was removed in v1; use "batch" (follow-ups are
   new batch runs on the same branch) or "review"`; anything else throws
   `mode must be "batch" or "review"`. `VALIDATION_ERROR` maps to 400, so
   `POST /api/v1/agents` with `mode: "interactive"` returns 400 with that message.

3. `worker/environment-config.ts`: `VALID_MODES` is `['batch', 'review']`; a removed mode
   in `setup.runOnModes` is filtered out with the note `ignored removed mode <x>` rather
   than throwing, while any other unknown mode still throws. The loader returns
   `{ config, notes }` (mirroring `review-repo-config.ts`), and `workspace-bootstrap.ts`
   writes the notes with `appendLog`.

4. `services/config-store.ts`: `LEGACY_CONFIG_KEYS` documents the keys from the removed
   modes. `loadRaw` keeps only known keys and warns once with
   `logger.warn({ keys }, 'ignoring unknown config keys')`, so `saveConfig` no longer writes
   them back. Keys `AppConfig` declares but `DEFAULT_CONFIG` does not default
   (`enabledRuntimeProfiles`, `bootstrapAutoDetect`, `globalSetupTimeoutMs`) are still
   read from the file, so the worker env-hydration behaviour is unchanged.

5. `worker/repo-config.ts`: unknown keys (the legacy `interactiveContextPrompt`,
   `loopContextPrompt`, `checkCommand` among them) are reported as the note
   `Ignoring unknown keys in .localagent-box/config.json: a, b` instead of being silently
   ignored. Callers append the notes to the agent log: `session-orchestrator.ts` and
   `review-repo-config.ts` (whose `notes[]` now carries them).

6. Legacy records: `isLegacyMode(agent)` in `agent.types.ts`. `restoreOnStartup` fails any
   legacy record in a non-terminal status with `Legacy <mode> session stopped by v1 upgrade`
   (including `awaiting_input`, which no run can set). `retryAgent` and `allowSuccessors`
   throw `Legacy <mode> sessions are read-only` (`VALIDATION_ERROR`), and the worker spawner
   refuses to start a legacy record so it cannot run as a batch.

7. Statuses: `awaiting_input` removed from `ACTIVE_STATUSES` (`agent.types.ts`),
   `BRANCH_WORKER_STATUSES` (`queue-eligibility.ts`), `ACTIVE_AGENT_STATUSES`
   (`lib/agent-review-gating.ts`) and the client sets; `Badge.tsx` no longer maps it, so a
   legacy record renders with the neutral badge. Legacy records are skipped when deciding
   whether a branch is occupied, and also when finding a coding predecessor — a read-only
   record can never release a successor, so otherwise a queued successor behind it would wait
   forever.

8. Tests: `lib/validation.test.ts`, `agent.validation.test.ts`,
   `environment-config.test.ts`, `repo-config.test.ts`, `queue-eligibility.test.ts`,
   `agent.service.test.ts`, and the new `services/config-store.test.ts`.

## Review

- `npm run build` passes, `npx tsc -p client` passes, and all 750 tests pass
  (`npm test` reports 191 because its `src/**/*.test.ts` glob only matches one directory
  level; the nested files were run explicitly with `npx tsx --test`).
- Verified end to end for the API criterion: `parseCreateAgentPayload` with
  `mode: 'interactive'` throws `VALIDATION_ERROR`, which `httpStatusForError` maps to 400
  with the "removed in v1" message.
- One judgement call beyond the brief: `findCodingPredecessor` also skips legacy records
  (step 7). With retry and `allowSuccessors` closed off for them, a legacy predecessor would
  otherwise permanently block its branch.
- `handleWorkerExit` still names `awaiting_input` when a killed worker exits; that path can
  no longer be reached by a current run, so it was left alone.
- The client change is limited to the status set and the badge variant; legacy records
  already render read-only from item 0.1.
