FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY main.go ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/filemgr .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/filemgr /filemgr
USER nonroot:nonroot
ENV PORT=1115
ENV FILEMGR_ROOT=/work
EXPOSE 1115
ENTRYPOINT ["/filemgr"]
