# Trixie provides fd with --no-require-git, required by pi find outside Git repos.
FROM node:22-trixie-slim

# ripgrep and fd back the grep/find tools; git + curl are what the agent reaches for
# most often from bash.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates curl ripgrep fd-find \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

# Run as the unprivileged node user that ships with the base image; the
# sandbox Pod's fsGroup (1000) makes the workspace PVC writable for it.
#
# Pre-create /home/node/.agents (owned by node) so the read-only skills PVC,
# which the backend submounts at /home/node/.agents/skills, lands inside an
# existing node-owned dir instead of a kubelet-created root:root parent.
RUN mkdir -p /work /home/node/.agents \
    && chown -R node:node /app /work /home/node/.agents

USER node

ENV PORT=1114
ENV WORK_DIR=/work
ENV HOME=/home/node

EXPOSE 1114

CMD ["node_modules/.bin/tsx", "src/server.ts"]
