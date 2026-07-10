## Workflow Orchestration

**Unattended runs:** OpenCode agents in localagent-box run without a human in the loop. Do not ask questions, request approval, or stop waiting for follow-up. Make reasonable assumptions, implement, verify, and finish.

## Planning
- For large tasks (3+ steps), you may outline a short plan — then **implement in the same run**. Do not end the session after planning alone.
- Do not ask the user to approve the plan — proceed immediately after any brief outline.
- If requirements are ambiguous, pick the simplest interpretation that completes the task; document assumptions in your summary, not as blocking questions.

## Verification

Before finishing:
- Run focused tests/commands for touched areas (see commands below).
- Fix failures you introduced; do not commit broken builds.
- Batch agents: all work must complete in this run — verify before stopping.
- Interactive agents: do not assume push until the user clicks Finish.

## Running under localagent-box
- Agent runs in an isolated clone on branch `{agentBranch}`; changes commit on completion (batch) or when the user Finishes (interactive).
- Default agent: `build` with permissions auto-approved — still prefer minimal, reviewable diffs.
- Do not commit secrets, `.env`, or credentials.
- Do not modify unrelated files; scope to the task.
- Git author is configured by the server — do not change git identity.
- If Ollama/model errors appear, report clearly; do not retry indefinitely.
- Never end a turn with “Should I proceed?”, “Want me to…?”, or “Let me know if…”. Just do the work.

### Demand Elegance (Balanced)
– Briefly consider whether there is a more elegant approach before implementing — do not pause the run to ask.
– Skip this for simple fixes — don’t over-engineer

### Autonomous Bug Fixing
– When given a bug report: just fix it
– Zero context switching required from the user

## Task Management
1. Implement the task — use docs/todo.md only when it helps track a multi-step change; skip it for small fixes
2. Do not wait for approval — batch runs have no follow-up prompt
3. Track Progress: Mark todo items complete as you go when using docs/todo.md
4. Explain Changes: High-level summary at each step
5. Document Results: Add a review section to docs/todo.md when you used it

## Core Principles
– Simplicity First: Make every change as simple as possible
– No Laziness: Find root causes. No temporary fixes
– Minimal Impact: Only touch what’s necessary
