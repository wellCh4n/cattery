# The complete extra font archive stays in this build stage, never in runtime layers.
FROM debian:trixie-slim AS fonts
RUN apt-get update && apt-get install -y --no-install-recommends python3-minimal \
    && cd /tmp && apt-get download texlive-fonts-extra
RUN apt-get install -y --no-install-recommends python3
COPY latex/select-fonts.py /tmp/select-fonts.py
RUN python3 /tmp/select-fonts.py

# Trixie provides fd with --no-require-git, required by pi find outside Git repos.
FROM node:22-trixie-slim

# XeLaTeX and fonts for the file browser's LaTeX previews (and the agent),
# first: the largest and least often changed layers.
# lmodern: newpxtext switches to T1 while Latin Modern is still the default.
RUN apt-get update && apt-get install -y --no-install-recommends \
    texlive-xetex texlive-lang-chinese texlive-fonts-recommended \
    texlive-science texlive-bibtex-extra texlive-plain-generic \
    lmodern latexmk biber python3-pygments fontconfig ca-certificates \
    fonts-noto-cjk fonts-texgyre fonts-texgyre-math fonts-dejavu fonts-liberation \
    fonts-noto-core fonts-firacode fonts-linuxlibertine fonts-freefont-otf \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*
COPY --from=fonts /selected/ /
COPY latex/fonts.conf /etc/fonts/conf.d/09-cattery-texmf.conf
RUN mktexlsr && updmap-sys && fc-cache -f
# LaTeX's first aid for cleveref (TeX Live 2024) labels counters with
# \csname p@<c>\endcsname\csname the<c>\endcsname. ctex's \p@section takes
# \thesection as an argument and swallows \csname instead, so \cref fails in
# ctexart documents. Expand \the<c> first, as the kernel's \refstepcounter
# does. The file is part of the LaTeX formats, which are rebuilt with it.
RUN src="$(kpsewhich latex2e-first-aid-for-external-files.ltx)" \
    && dest=/usr/local/share/texmf/tex/latex/firstaid/latex2e-first-aid-for-external-files.ltx \
    && mkdir -p "$(dirname "$dest")" \
    && sed 's/\\csname p@#1\\endcsname\\csname the#1\\endcsname}%$/\\csname p@#1\\expandafter\\endcsname\\csname the#1\\endcsname}%/' "$src" > "$dest" \
    && test "$(diff "$src" "$dest" | grep -c '^>')" = 1 \
    && mktexlsr && fmtutil-sys --all > /dev/null
COPY latex/check-latex.py /usr/local/libexec/check-latex.py
# Checked as the runtime uid with the HOME previews compile with; a failure
# stops the build.
USER 1000:1000
RUN HOME=/tmp python3 /usr/local/libexec/check-latex.py
USER root

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
    && mkdir -p /home/cattery/.agents \
    && chown -R cattery:cattery /app /home/cattery

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
