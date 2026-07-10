# Tool calling requirements (Ollama / local models)

When calling the `bash` tool, you **must** include a `description` parameter (5–10 words describing what the command does). OpenCode rejects bash calls without it.

Examples:
- `bash(command="ls -la", description="List files in current directory")`
- `bash(command="git status", description="Show working tree status")`
- `bash(command="npm install", description="Install package dependencies")`

Do **not** call bash with only `command` — always include `description`.

Prefer dedicated tools when available: use **Read** (not `cat`), **Grep** (not `grep`), **Glob** (not `find`/`ls`), **Write** (not `echo >`).
