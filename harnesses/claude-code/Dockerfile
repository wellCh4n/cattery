FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY src/ ./src/

# claude CLI refuses to run --dangerously-skip-permissions as root; use the
# node user that ships with the base image and own /app + /work.
#
# Pre-create /home/node/.claude (owned by node) so the read-only skills PVC,
# which the backend submounts at /home/node/.claude/skills, lands inside an
# existing node-owned dir. Otherwise the kubelet auto-creates the parent
# /home/node/.claude as root:root, and the SDK — running as node — can't write
# session transcripts to /home/node/.claude/projects/. That breaks `resume`:
# turn 1 runs in-memory, but every later turn fails with
# "No conversation found with session ID: …".
RUN mkdir -p /work /home/node/.claude \
    && chown -R node:node /app /work /home/node/.claude

USER node

ENV PATH="/app/node_modules/.bin:${PATH}"
ENV PORT=1114
ENV WORK_DIR=/work
ENV HOME=/home/node

EXPOSE 1114

CMD ["node_modules/.bin/tsx", "src/server.ts"]
