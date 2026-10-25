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

func TestSetSessionName(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch || r.URL.Path != "/session/s/name" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		if string(body) != `{"name":" manual "}` {
			t.Errorf("unexpected body: %s", body)
		}
		fmt.Fprint(w, `{"name":"manual"}`)
	}))
	defer server.Close()
	name, err := NewClient().SetSessionName(context.Background(), server.URL, "s", " manual ")
	if err != nil || name != "manual" {
		t.Fatalf("name=%q err=%v", name, err)
	}
}

func TestSetSessionNameFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer server.Close()
	if _, err := NewClient().SetSessionName(context.Background(), server.URL, "s", "manual"); err == nil {
		t.Fatal("expected native sync error")
	}
}

func TestUsageReadsLedgerPage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/usage" || r.URL.Query().Get("offset") != "42" {
			t.Errorf("unexpected request %s", r.URL)
		}
		fmt.Fprint(w, `{"records":[{"id":"r1","sessionId":"5b0c7d4e-7d2a-4a39-9d55-6a1c0f3e2b11","at":1761350400000,"kind":"title","model":"small","input":10,"output":2,"cacheRead":3,"cacheWrite":4}],"offset":200,"more":true}`)
	}))
	defer server.Close()
	page, err := NewClient().Usage(context.Background(), server.URL, 42)
	if err != nil {
		t.Fatal(err)
	}
	if page.Offset != 200 || !page.More || len(page.Records) != 1 {
		t.Fatalf("page = %+v", page)
	}
	r := page.Records[0]
	if r.ID != "r1" || r.SessionID.String() != "5b0c7d4e-7d2a-4a39-9d55-6a1c0f3e2b11" || r.Kind != "title" || r.Input != 10 || r.CacheWrite != 4 || r.At != 1761350400000 {
		t.Fatalf("record = %+v", r)
	}
}
