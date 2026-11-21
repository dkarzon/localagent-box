#!/bin/bash

set -e

DATA_DIR="${DATA_DIR:-/data}"

mkdir -p "${DATA_DIR}/agents" /workspace/agents

# OpenCode v2 bootstraps its SQLite schema in milliseconds per agent, so the v1-era
# database template pre-warm is gone. Drop any template left on the volume by older images.
rm -rf "${DATA_DIR}/opencode-template"

exec node /app/dist/server.js
