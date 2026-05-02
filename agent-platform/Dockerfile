# syntax=docker/dockerfile:1.6
#
# Worker image for the autonomous AI agent platform.
# Provides: Node 20, gh CLI, Anthropic Claude Code CLI, OpenAI Codex CLI, git.
#
FROM node:20-bookworm-slim AS base

ENV DEBIAN_FRONTEND=noninteractive

# System packages: git for cloning, curl/ca-certificates for installing gh.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      curl \
      ca-certificates \
      gnupg \
      openssh-client \
      jq \
 && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI (gh) from the official apt repo.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Install Claude Code and Codex CLIs globally.
RUN npm install -g \
      @anthropic-ai/claude-code \
      @openai/codex \
 && npm cache clean --force

# ---- App build stage ----
FROM base AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime stage ----
FROM base AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    TEMPORAL_ADDRESS=temporal-frontend.temporal.svc.cluster.local:7233 \
    TEMPORAL_NAMESPACE=default \
    TEMPORAL_TASK_QUEUE=agent-platform \
    HOME=/home/agent

RUN useradd -m -u 1001 -d /home/agent agent \
 && mkdir -p /home/agent/.claude /workspaces \
 && chown -R agent:agent /home/agent /workspaces

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

USER agent
WORKDIR /app

CMD ["node", "dist/worker.js"]
