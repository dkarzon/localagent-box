#!/bin/bash

set -e

DATA_DIR="${DATA_DIR:-/data}"
TEMPLATE_MARKER="${DATA_DIR}/opencode-template/.migrated"
TEMPLATE_DIR="${DATA_DIR}/opencode-template/share-opencode"

mkdir -p "${DATA_DIR}/agents" /workspace/agents

# Pre-migrate OpenCode's SQLite DB once per volume so per-agent isolated dirs can be seeded
# without repeating the multi-minute migration on every agent start.
prewarm_opencode_template() {
  if [ -f "${TEMPLATE_MARKER}" ] && [ -d "${TEMPLATE_DIR}" ]; then
    echo "OpenCode DB template already present at ${TEMPLATE_DIR}"
    return 0
  fi

  echo "Pre-migrating OpenCode database template (first container start; may take several minutes)..."
  mkdir -p "${DATA_DIR}/opencode-template"

  opencode serve --hostname 127.0.0.1 --port 4099 &
  local pid=$!
  local waited=0
  local max_wait=900

  while [ "${waited}" -lt "${max_wait}" ]; do
    if curl -sf "http://127.0.0.1:4099/path" >/dev/null 2>&1; then
      echo "OpenCode template migration complete after ${waited}s"
      kill -TERM "${pid}" 2>/dev/null || true
      wait "${pid}" 2>/dev/null || true
      rm -rf "${TEMPLATE_DIR}"
      cp -a /home/node/.local/share/opencode "${TEMPLATE_DIR}"
      touch "${TEMPLATE_MARKER}"
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
    if [ $((waited % 30)) -eq 0 ]; then
      echo "OpenCode template migration still running (${waited}s elapsed)..."
    fi
  done

  echo "WARNING: OpenCode template pre-migration timed out after ${max_wait}s" >&2
  kill -TERM "${pid}" 2>/dev/null || true
  wait "${pid}" 2>/dev/null || true
  return 1
}

prewarm_opencode_template || echo "WARNING: continuing without OpenCode DB template" >&2

exec node /app/dist/server.js
