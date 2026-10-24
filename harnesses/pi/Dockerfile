# Trixie provides fd with --no-require-git, required by pi find outside Git repos.
FROM node:22-trixie-slim

# ripgrep and fd back the grep/find tools; git + curl are what the agent reaches for
# most often from bash. tmux keeps web terminal shells alive across reconnects.
# Python 3 (also as `python`) with pip and venv for scripts the agent runs.
# The real procps/psmisc/iproute2/lsof (not busybox, which lacks pkill, lsof,
# ss and GNU flags) to find and stop processes, plus everyday shell tools.
# There is no sudo, so nothing can be installed later.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates curl ripgrep fd-find tmux \
    python3 python3-pip python3-venv python-is-python3 \
    procps psmisc iproute2 lsof less jq zip unzip wget file tree vim-tiny openssh-client \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

COPY tmux.conf /etc/tmux.conf
COPY docker-entrypoint.sh /usr/local/bin/cattery-entrypoint

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

# Run as an unprivileged `cattery` user — the base image's node user renamed,
# keeping uid/gid 1000 so the sandbox Pod's fsGroup (1000) still makes the
# workspace PVC writable for it.
#
# The home directory is replaced by the project PVC at runtime. The entrypoint
# seeds missing shell defaults there without overwriting user configuration.
RUN groupmod -n cattery node \
    && usermod -l cattery -d /home/cattery -m node \
    && mkdir -p /home/cattery/.agents /cattery/global-skills \
    && chown -R cattery:cattery /app /home/cattery /cattery

USER cattery

ENV PORT=1114
ENV WORK_DIR=/home/cattery
ENV HOME=/home/cattery
# Let `pip install` work outside a venv: Debian marks the system Python as
# externally managed, and as a non-root user pip falls back to ~/.local on the
# workspace PVC, so installed packages persist with the project.
ENV PIP_BREAK_SYSTEM_PACKAGES=1
ENV PATH=/home/cattery/.local/bin:$PATH

EXPOSE 1114

WORKDIR /home/cattery
ENTRYPOINT ["/bin/sh", "/usr/local/bin/cattery-entrypoint"]
CMD ["/app/node_modules/.bin/tsx", "/app/src/server.ts"]
