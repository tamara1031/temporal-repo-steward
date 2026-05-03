# syntax=docker/dockerfile:1.6
#
# Worker image for the autonomous AI agent platform.
# Provides: Node 20, gh CLI, OpenAI Codex CLI, git.
#
FROM node:20-bookworm-slim AS base

ENV DEBIAN_FRONTEND=noninteractive

# System packages: git for cloning, curl/ca-certificates for installing gh,
# bubblewrap so codex can use `--sandbox <mode>` (instead of the bypass flag)
# without falling back to its vendored bwrap, which doesn't enforce reliably.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      curl \
      ca-certificates \
      gnupg \
      openssh-client \
      jq \
      bubblewrap \
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

# Install Codex CLI globally.
RUN npm install -g @openai/codex \
 && npm cache clean --force

# ---- App build stage ----
FROM base AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
# `npm run build` runs `tsc` AND emits `dist/workflow-bundle.js` via
# `scripts/build-workflow-bundle.ts`. The runtime worker reads that bundle
# instead of bundling at startup (Temporal best practice for production).
RUN npm run build

# ---- Runtime stage ----
FROM base AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    TEMPORAL_ADDRESS=temporal-frontend.temporal.svc.cluster.local:7233 \
    TEMPORAL_NAMESPACE=default \
    TEMPORAL_TASK_QUEUE=repo-steward \
    HOME=/home/agent

# Match the host UID (1000) so bind-mounted files like ~/.codex/auth.json
# (mode 600, owned by the host user) remain readable inside the container.
# The base node image ships a `node` user at UID 1000, which we replace.
RUN userdel -r node 2>/dev/null || true \
 && useradd -m -u 1000 -d /home/agent agent \
 && mkdir -p /home/agent/.codex /workspaces \
 && chown -R agent:agent /home/agent /workspaces

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Codex CLI is invoked once per role from `src/activities/refactor.ts` with
# inline prompts — there are no codex subagent TOMLs to bake into the image.
# (Auth lives at $HOME/.codex/auth.json, mounted at runtime as a Secret.)

USER agent
WORKDIR /app

CMD ["node", "dist/worker.js"]
