package api

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wellch4n/cattery/internal/live"
)

func TestAppsWatcherSendsOnlyChanges(t *testing.T) {
	var mu sync.Mutex
	apps := []listeningApp{{Port: 3000}}
	reads := 0
	hub := live.NewHub()
	w := newAppsWatcher(func(context.Context, uuid.UUID) ([]listeningApp, error) {
		mu.Lock()
		defer mu.Unlock()
		reads++
		return slicesClone(apps), nil
	}, hub)
	hub.OnWatch(w.watch)
	project := uuid.New()
	c := hub.Add(live.User{UserID: uuid.New()})
	hub.Subscribe(c, project)

	frame := func() (string, []listeningApp) {
		t.Helper()
		select {
		case raw := <-c.Send:
			var f struct {
				Type string `json:"type"`
				Data struct {
					Apps []listeningApp `json:"apps"`
				} `json:"data"`
			}
			if err := json.Unmarshal(raw, &f); err != nil {
				t.Fatal(err)
			}
			return f.Type, f.Data.Apps
		case <-time.After(time.Second):
			t.Fatal("no frame")
			return "", nil
		}
	}
	if typ, _ := frame(); typ != "presence" {
		t.Fatalf("first frame %q", typ)
	}
	if typ, got := frame(); typ != "apps" || len(got) != 1 || got[0].Port != 3000 {
		t.Fatalf("initial apps frame %q %v", typ, got)
	}
	// Unchanged rereads send nothing, even when start times wobble.
	mu.Lock()
	apps[0].StartedAt = "2026-10-28T05:34:44.175Z"
	mu.Unlock()
	w.poke(project)
	time.Sleep(50 * time.Millisecond)
	select {
	case raw := <-c.Send:
		t.Fatalf("unexpected frame %s", raw)
	default:
	}
	mu.Lock()
	apps = append(apps, listeningApp{Port: 5173, PID: 7})
	mu.Unlock()
	w.poke(project)
	if typ, got := frame(); typ != "apps" || len(got) != 2 || got[1].Port != 5173 {
		t.Fatalf("changed apps frame %q %v", typ, got)
	}

	// The last subscriber leaving stops the poller.
	hub.Remove(c)
	w.mu.Lock()
	running := len(w.running)
	w.mu.Unlock()
	if running != 0 {
		t.Fatalf("%d pollers still running", running)
	}
	mu.Lock()
	before := reads
	mu.Unlock()
	w.poke(project)
	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if reads != before {
		t.Fatalf("read after the last subscriber left")
	}
}

func slicesClone(a []listeningApp) []listeningApp { return append([]listeningApp(nil), a...) }
