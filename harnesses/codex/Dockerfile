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

# Codex CLI (OpenAI) — official npm package.
RUN npm install -g @openai/codex@latest

# codex-relay: Responses ↔ Chat Completions translator (Rust binary shipped
# via PyPI wheel for convenience). Codex >=0.131 hardcodes wire_api =
# "responses", but our NewAPI gateway only translates Chat Completions →
# Anthropic Messages for claude-* models (Responses → Anthropic is still
# 🚧 upstream). codex-relay sits in this container as a sidecar: codex
# talks Responses to 127.0.0.1, the relay emits Chat Completions to
# OPENAI_BASE_URL, NewAPI fans out to Anthropic or OpenAI per model.
# --break-system-packages: container is sealed, no system Python to protect.
RUN pip install --break-system-packages --no-cache-dir codex-relay==0.2.0

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
RUN printf 'set -g mouse on\nset -g history-limit 50000\nset -g default-terminal "tmux-256color"\nset -as terminal-overrides ",*:Tc"\n' > /home/node/.tmux.conf \
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
