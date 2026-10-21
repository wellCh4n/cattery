FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/filemgr .

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends texlive-xetex texlive-lang-chinese fonts-noto-cjk ca-certificates && rm -rf /var/lib/apt/lists/*
# hyperref requires the pzdr metrics from the recommended font collection.
RUN apt-get update && apt-get install -y --no-install-recommends texlive-fonts-recommended && rm -rf /var/lib/apt/lists/*
# Common scientific documents, bibliographies, and portable font families.
RUN apt-get update && apt-get install -y --no-install-recommends \
    texlive-science texlive-bibtex-extra texlive-fonts-extra \
    latexmk biber python3-pygments fontconfig \
    fonts-texgyre fonts-texgyre-math fonts-dejavu fonts-liberation \
    fonts-noto-core fonts-firacode fonts-linuxlibertine fonts-freefont-otf \
    && rm -rf /var/lib/apt/lists/*
# NewTX uses the generic binhex macros even when compiling with XeLaTeX.
RUN apt-get update && apt-get install -y --no-install-recommends texlive-plain-generic && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/filemgr /filemgr
COPY check-latex.py /usr/local/libexec/check-latex.py
USER 1000:1000
ENV HOME=/tmp
ENV PORT=1115
ENV FILEMGR_ROOT=/work
RUN python3 /usr/local/libexec/check-latex.py
EXPOSE 1115
ENTRYPOINT ["/filemgr"]
