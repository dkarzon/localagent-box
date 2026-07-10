# Tool calling requirements (Ollama / local models)

Do **not** create or modify `opencode-tool-instructions.md` — tool guidance is injected via OpenCode config.

When calling the `bash` tool, you **must** include a `description` parameter (5–10 words describing what the command does). OpenCode rejects bash calls without it.

Examples:
- `bash(command="ls -la", description="List files in current directory")`
- `bash(command="git status", description="Show working tree status")`
- `bash(command="npm install", description="Install package dependencies")`

Do **not** call bash with only `command` — always include `description`.

Prefer dedicated tools when available: use **Read** (not `cat`), **Grep** (not `grep`), **Glob** (not `find`/`ls`), **Write** (not `echo >`).

## Batch (one-shot) runs

Batch agents get a single unattended turn. **You must change repository files** to complete the task — plans, summaries, or `docs/todo.md` alone are not enough. Use tools (Read, Write, Edit, bash, etc.) to implement, run focused checks when relevant, then stop only after edits exist.
