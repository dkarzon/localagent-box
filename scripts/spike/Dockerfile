FROM node:trixie

RUN apt-get update && apt-get install -y \
    git \
    bash \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# dsh plugin add uses pnpm under the hood
RUN npm install -g corepack@0.34.7 && corepack enable && pnpm --version

WORKDIR /spike

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY . ./

# Default: run spike against compose ollama service
ENV OLLAMA_BASE_URL=http://ollama:11434
ENV DSH_MODEL=llama3.2
ENV SPIKE_TIMEOUT_MS=900000

CMD ["node", "dsh-ollama-spike.mjs"]
