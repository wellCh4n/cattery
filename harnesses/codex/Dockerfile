# Codex TUI harness
#
# Browser <--WS--> backend proxy <--WS--> this container <--PTY--> codex CLI
#
# tmux wraps the codex process so the in-memory conversation survives WS
# reconnects: the Node bridge spawns `tmux new-session -d $TUI_CMD` on
# POST /session and `tmux attach -d` per WS client. Killing the WS only
# kills the attach client; the tmux server + codex keep running.

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl tmux python3 python3-pip make g++ bubblewrap \
    && rm -rf /var/lib/apt/lists/*

# Codex CLI (OpenAI) — official npm package. Pinned (not @latest) so the image
# is reproducible and stays in lockstep with the codex-relay pin below; bump
# both together. @latest would also be silently frozen at build time by
# Docker's layer cache, so rebuilds wouldn't actually pick up new releases.
ARG CODEX_VERSION=0.135.0
RUN npm install -g @openai/codex@${CODEX_VERSION}

# codex-relay: Responses ↔ Chat Completions translator (Rust binary shipped
# via PyPI wheel for convenience). Codex >=0.131 hardcodes wire_api =
# "responses", but our NewAPI gateway only translates Chat Completions →
# Anthropic Messages for claude-* models (Responses → Anthropic is still
# 🚧 upstream). codex-relay sits in this container as a sidecar: codex
# talks Responses to 127.0.0.1, the relay emits Chat Completions to
# OPENAI_BASE_URL, NewAPI fans out to Anthropic or OpenAI per model.
# --break-system-packages: container is sealed, no system Python to protect.
RUN pip install --break-system-packages --no-cache-dir codex-relay==0.2.3

WORKDIR /app

COPY package.json ./
RUN npm install

COPY src/ ./src/

# Codex refuses to run as root in some sandboxes; use the unprivileged
# `node` user that ships with the base image.
RUN mkdir -p /work /home/node/.codex && chown -R node:node /app /work /home/node/.codex

# tmux config — mouse on routes xterm.js wheel events into tmux's copy-mode
# so users can scroll TUI history (codex sits in alt-screen, so xterm's
# own scrollback never fills). history-limit grows what's scrollable.
# The copy-mode wheel bindings tack on `refresh-client` so each scroll
# forces a full repaint: without it tmux scrolls the pane region and the
# top-right `[N/M]` position indicator is carried down with the content
# instead of cleared, leaving a ghost trail of indicators on every tick.
RUN printf '%s\n' \
      'set -g mouse on' \
      'set -g history-limit 50000' \
      'set -g default-terminal "tmux-256color"' \
      'set -as terminal-overrides ",*:Tc"' \
      'bind -T copy-mode WheelUpPane send-keys -X -N 3 scroll-up \; refresh-client' \
      'bind -T copy-mode WheelDownPane send-keys -X -N 3 scroll-down \; refresh-client' \
      'bind -T copy-mode-vi WheelUpPane send-keys -X -N 3 scroll-up \; refresh-client' \
      'bind -T copy-mode-vi WheelDownPane send-keys -X -N 3 scroll-down \; refresh-client' \
      > /home/node/.tmux.conf \
    && chown node:node /home/node/.tmux.conf

USER node

ENV PATH="/app/node_modules/.bin:${PATH}"
ENV PORT=1114
ENV WORK_DIR=/work
ENV HOME=/home/node
ENV TUI_CMD=codex
# UTF-8 locale — without this tmux operates in single-byte mode and corrupts
# every multibyte char from the TUI. C.UTF-8 is built into glibc on the
# debian-bookworm base so no locale-gen step is needed.
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

EXPOSE 1114

CMD ["node_modules/.bin/tsx", "src/server.ts"]
