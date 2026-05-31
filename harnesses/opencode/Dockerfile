FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

# install opencode — pinned via the install script's --version so rebuilds are
# reproducible; an unpinned install is silently frozen at the first build by
# Docker's layer cache and never picks up new releases on rebuild.
ARG OPENCODE_VERSION=1.15.13
RUN curl -fsSL https://opencode.ai/install | bash -s -- --version ${OPENCODE_VERSION}

ENV PATH="/root/.opencode/bin:${PATH}"

ENV PORT=1114
ENV REPO_DIR=/work/repo

WORKDIR /work

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 1114

ENTRYPOINT ["/entrypoint.sh"]
