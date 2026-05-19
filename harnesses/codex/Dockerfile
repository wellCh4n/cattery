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
      git ca-certificates curl tmux python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Codex CLI (OpenAI) — official npm package.
RUN npm install -g @openai/codex@latest

WORKDIR /app

COPY package.json ./
RUN npm install

COPY src/ ./src/

# Codex refuses to run as root in some sandboxes; use the unprivileged
# `node` user that ships with the base image.
RUN mkdir -p /work /home/node/.codex && chown -R node:node /app /work /home/node/.codex
USER node

ENV PATH="/app/node_modules/.bin:${PATH}"
ENV PORT=4096
ENV WORK_DIR=/work
ENV HOME=/home/node
ENV TUI_CMD=codex

EXPOSE 4096

CMD ["node_modules/.bin/tsx", "src/server.ts"]
