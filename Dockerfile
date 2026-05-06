FROM golang:1.23-bookworm AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /repo-steward ./cmd

FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      curl \
      ca-certificates \
      gnupg \
      openssh-client \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Install Node + Codex CLI (codex CLI requires Node runtime).
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && npm install -g @openai/codex \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1000 -d /home/agent agent \
 && mkdir -p /home/agent/.codex /workspaces \
 && chown -R agent:agent /home/agent /workspaces

COPY --from=builder /repo-steward /usr/local/bin/repo-steward

USER agent
ENV HOME=/home/agent \
    XDG_CACHE_HOME=/tmp \
    WORKSPACE_ROOT=/workspaces

ENTRYPOINT ["/usr/local/bin/repo-steward"]
