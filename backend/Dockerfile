# syntax=docker/dockerfile:1.7
# The builder runs on the build machine's own platform and cross-compiles, so
# `--platform linux/amd64` on an arm64 Mac needs no emulation.
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS builder

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .
ARG TARGETOS TARGETARCH
# timetzdata embeds the zone database, so the runtime image needs no tzdata.
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -tags timetzdata -ldflags="-s -w" -o /out/server ./cmd/server/

# No apk step: CA certificates come from the builder, so the build never
# reaches the Alpine package mirror.
FROM alpine:3.20
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=builder /out/server /usr/local/bin/server

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/server"]
