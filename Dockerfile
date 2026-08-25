FROM node:trixie AS ui-builder

WORKDIR /app
COPY client/package.json client/package-lock.json* ./client/
WORKDIR /app/client
RUN npm ci 2>/dev/null || npm install
COPY client/ ./
RUN npm run build

FROM node:trixie AS server-builder

WORKDIR /app
COPY package.json package-lock.json* tsconfig.json ./
RUN npm ci --ignore-scripts 2>/dev/null || npm install --ignore-scripts
COPY src ./src
RUN npm run build

FROM node:trixie

RUN apt update && apt install -y \
    git \
    bash \
    curl \
    ca-certificates \
    file \
    ripgrep \
    build-essential \
    cmake \
    python3 \
    python3-pip \
    python3.13-venv \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /workspace/agents /data /app \
    && chown -R node:node /workspace /data /app

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts 2>/dev/null || npm install --omit=dev --ignore-scripts

COPY --from=server-builder /app/dist ./dist
COPY --from=ui-builder /app/public ./public
COPY config ./config
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh && chown -R node:node /app

RUN npm install -g opencode-ai@v1.18.21
RUN npm install -g @alibaba-group/open-code-review@v1.9.10

# corepack: required by the nodejs-pnpm / nodejs-yarn bootstrap profiles.
# Not bundled with modern node: images, so install and enable it, then
# smoke-test that pnpm resolves through the corepack shim.
# Pin to a tested version so rebuilds are reproducible: corepack changes
# shim behaviour between releases (pnpm/yarn resolution) and 0.32+
# deprecates `corepack enable`. 0.34.7 is the last line where `enable`
# still works and engines cover the node:trixie base Node range.
RUN npm install -g corepack@0.34.7 \
    && corepack enable \
    && pnpm --version

# codegraph MCP server (stdio). Bundles its own runtime — no native build needed.
RUN npm install -g @colbymchenry/codegraph \
    && codegraph --version
ENV CODEGRAPH_TELEMETRY=0

RUN mkdir -p /home/node/.local/share/opencode \
    /home/node/.local/state \
    /home/node/.config/opencode \
    && chown -R node:node /home/node/.local /home/node/.config

USER node

WORKDIR /workspace

ENV PORT=8080
ENV DATA_DIR=/data
ENV API_TOKEN=localagent-box

ENTRYPOINT ["/app/entrypoint.sh"]
