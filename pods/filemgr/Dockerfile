FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/filemgr .

# The complete extra font archive stays in this build stage, never in runtime layers.
FROM debian:bookworm-slim AS fonts
RUN apt-get update && apt-get install -y --no-install-recommends python3-minimal \
    && cd /tmp && apt-get download texlive-fonts-extra
RUN apt-get install -y --no-install-recommends python3
COPY select-fonts.py /tmp/select-fonts.py
RUN python3 /tmp/select-fonts.py

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    texlive-xetex texlive-lang-chinese texlive-fonts-recommended \
    texlive-science texlive-bibtex-extra texlive-plain-generic \
    latexmk biber python3-pygments fontconfig ca-certificates \
    fonts-noto-cjk fonts-texgyre fonts-texgyre-math fonts-dejavu fonts-liberation \
    fonts-noto-core fonts-firacode fonts-linuxlibertine fonts-freefont-otf \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*
COPY --from=fonts /selected/ /
COPY fonts.conf /etc/fonts/conf.d/09-cattery-texmf.conf
RUN mktexlsr && updmap-sys && fc-cache -f
COPY --from=build /out/filemgr /filemgr
COPY check-latex.py /usr/local/libexec/check-latex.py
USER 1000:1000
ENV HOME=/tmp
ENV PORT=1115
ENV FILEMGR_ROOT=/home/cattery
RUN python3 /usr/local/libexec/check-latex.py
EXPOSE 1115
ENTRYPOINT ["/filemgr"]
