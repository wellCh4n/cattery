package api

import (
	"context"
	"slices"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/wellch4n/cattery/internal/live"
)

// appsPollEvery is how often a watched project's listening apps are reread.
const appsPollEvery = 3 * time.Second

// appsWatcher pushes each watched project's listening apps over the live
// channel as an "apps" frame ({apps}, the whole list). Linux has no
// notification for a socket starting to listen, so it rereads the agent's
// /ports every few seconds, but only while the project has subscribers, and
// sends the list only when it changed.
type appsWatcher struct {
	read func(context.Context, uuid.UUID) ([]listeningApp, error)
	hub  *live.Hub

	mu      sync.Mutex
	running map[uuid.UUID]*appsWatch
}

type appsWatch struct {
	cancel context.CancelFunc
	poke   chan struct{}
}

func newAppsWatcher(read func(context.Context, uuid.UUID) ([]listeningApp, error), hub *live.Hub) *appsWatcher {
	return &appsWatcher{read: read, hub: hub, running: map[uuid.UUID]*appsWatch{}}
}

// watch starts or stops polling projectID. The hub calls it under its own
// lock, so it only starts or cancels the poller.
func (w *appsWatcher) watch(projectID uuid.UUID, watching bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	current := w.running[projectID]
	switch {
	case watching && current == nil:
		ctx, cancel := context.WithCancel(context.Background())
		current = &appsWatch{cancel: cancel, poke: make(chan struct{}, 1)}
		w.running[projectID] = current
		go w.run(ctx, projectID, current.poke)
	case !watching && current != nil:
		current.cancel()
		delete(w.running, projectID)
	}
}

// poke rereads projectID's apps now, if it is watched.
func (w *appsWatcher) poke(projectID uuid.UUID) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if current := w.running[projectID]; current != nil {
		select {
		case current.poke <- struct{}{}:
		default: // A reread is already due.
		}
	}
}

// sameApps compares two sorted lists by what identifies each app. The agent
// derives start times from the clock and the system uptime, so they wobble by
// milliseconds between reads and are left out.
func sameApps(a, b []listeningApp) bool {
	return slices.EqualFunc(a, b, func(x, y listeningApp) bool {
		return x.Port == y.Port && x.PID == y.PID && x.Command == y.Command
	})
}

func (w *appsWatcher) run(ctx context.Context, projectID uuid.UUID, poke <-chan struct{}) {
	ticker := time.NewTicker(appsPollEvery)
	defer ticker.Stop()
	var last []listeningApp
	sent := false
	for {
		readCtx, cancel := context.WithTimeout(ctx, appsPollEvery)
		apps, err := w.read(readCtx, projectID)
		cancel()
		if ctx.Err() != nil {
			return
		}
		// A failed read (the agent restarting) keeps the last list.
		if err == nil && (!sent || !sameApps(apps, last)) {
			last, sent = apps, true
			w.hub.Publish(projectID, live.Event{Type: "apps", Data: map[string]any{"apps": apps}})
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-poke:
		}
	}
}
