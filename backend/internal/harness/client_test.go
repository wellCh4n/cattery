package harness

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSubscribeBeforePromptAndSuppressTitle(t *testing.T) {
	subscribed := make(chan struct{})
	prompted := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/event" {
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			close(subscribed)
			w.(http.Flusher).Flush()
			<-prompted
			fmt.Fprint(w, "data: {\"sessionId\":\"s\",\"type\":\"session.title\",\"data\":{\"title\":\"automatic\"}}\n\n")
			fmt.Fprint(w, "data: {\"sessionId\":\"s\",\"type\":\"session.idle\",\"data\":{}}\n\n")
			return
		}
		select {
		case <-subscribed:
		default:
			t.Error("prompt sent before subscription")
		}
		close(prompted)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	var out strings.Builder
	client := NewClient()
	err := client.StreamEventsUntilIdle(context.Background(), server.URL, "s", &out,
		func(ev *PlatformEvent) bool { return ev.Type != EventSessionTitle },
		func() error { return client.PromptAsync(context.Background(), server.URL, "s", "hello") })
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), "automatic") || !strings.Contains(out.String(), "session.idle") {
		t.Fatalf("unexpected output: %s", out.String())
	}
}

func TestStreamFailureDoesNotPrompt(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer server.Close()
	err := NewClient().StreamEventsUntilIdle(context.Background(), server.URL, "s", io.Discard, nil,
		func() error { t.Error("prompted after stream failure"); return nil })
	if err == nil {
		t.Fatal("expected stream error")
	}
}
