# Trixie provides fd with --no-require-git, required by pi find outside Git repos.
FROM node:22-trixie-slim

# ripgrep and fd back the grep/find tools; git + curl are what the agent reaches for
# most often from bash. tmux keeps web terminal shells alive across reconnects.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates curl ripgrep fd-find tmux \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

COPY tmux.conf /etc/tmux.conf

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

# Run as an unprivileged `cattery` user — the base image's node user renamed,
# keeping uid/gid 1000 so the sandbox Pod's fsGroup (1000) still makes the
# workspace PVC writable for it.
#
# Pre-create /home/cattery/.agents (owned by cattery) so the read-only skills
# PVC, which the backend submounts at /home/cattery/.agents/skills, lands inside
# an existing cattery-owned dir instead of a kubelet-created root:root parent.
RUN groupmod -n cattery node \
    && usermod -l cattery -d /home/cattery -m node \
    && mkdir -p /work /home/cattery/.agents \
    && chown -R cattery:cattery /app /work /home/cattery

USER cattery

ENV PORT=1114
ENV WORK_DIR=/work
ENV HOME=/home/cattery

EXPOSE 1114

CMD ["node_modules/.bin/tsx", "src/server.ts"]
