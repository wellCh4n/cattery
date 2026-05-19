# Hermes TUI harness
#
# Browser <--WS--> backend proxy <--WS--> this container <--PTY--> hermes CLI
#
# Hermes (Nous Research hermes-agent) is a Python CLI; we install it from a
# pinned release tag using uv. The Node bridge wraps it in tmux so WS
# reconnects don't lose conversation state.

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates bash curl python3 python3-venv python3-dev \
      make g++ ripgrep tmux \
    && rm -rf /var/lib/apt/lists/*

# uv (Astral) — single static binary, pinned + checksum-verified.
ARG UV_VERSION=0.5.11
RUN ARCH=$(uname -m) && \
    case "$ARCH" in \
      x86_64) UV_TARGET="x86_64-unknown-linux-gnu" ;; \
      aarch64) UV_TARGET="aarch64-unknown-linux-gnu" ;; \
      *) echo "unsupported arch $ARCH" && exit 1 ;; \
    esac && \
    cd /tmp && \
    curl -fsSL -o uv.tar.gz "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${UV_TARGET}.tar.gz" && \
    curl -fsSL -o uv.tar.gz.sha256 "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${UV_TARGET}.tar.gz.sha256" && \
    EXPECTED=$(awk '{print $1}' uv.tar.gz.sha256) && \
    ACTUAL=$(sha256sum uv.tar.gz | awk '{print $1}') && \
    if [ "$EXPECTED" != "$ACTUAL" ]; then \
      echo "uv checksum mismatch: expected $EXPECTED got $ACTUAL" >&2; exit 1; \
    fi && \
    tar -xzf uv.tar.gz && \
    mv uv-${UV_TARGET}/uv /usr/local/bin/uv && \
    rm -rf uv.tar.gz uv.tar.gz.sha256 uv-${UV_TARGET} && \
    uv --version

# hermes-agent pinned release. The `[all]` extra pulls Playwright/Chromium +
# voice deps; skip it for a coding TUI.
ARG HERMES_VERSION=v2026.5.16
RUN git clone --depth 1 --branch ${HERMES_VERSION} \
      https://github.com/NousResearch/hermes-agent.git /opt/hermes \
    && cd /opt/hermes \
    && uv venv /opt/hermes/.venv --python 3.11 \
    && . /opt/hermes/.venv/bin/activate \
    && uv pip install -e . anthropic openai \
    && ln -sf /opt/hermes/.venv/bin/hermes /usr/local/bin/hermes

WORKDIR /app

COPY package.json ./
RUN npm install

COPY src/ ./src/

RUN mkdir -p /work && chown -R node:node /app /work
USER node

ENV PATH="/app/node_modules/.bin:${PATH}"
ENV PORT=4096
ENV WORK_DIR=/work
ENV HOME=/home/node
ENV TUI_CMD=hermes

EXPOSE 4096

CMD ["node_modules/.bin/tsx", "src/server.ts"]
