FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY main.go ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/skillmgr .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/skillmgr /skillmgr
USER nonroot:nonroot
ENV PORT=1116
ENV SKILLMGR_ROOT=/skills
EXPOSE 1116
ENTRYPOINT ["/skillmgr"]
