// Package usage pulls token usage from project sandboxes into the database.
//
// Each agent appends one line per model request to a ledger on its workspace
// PVC. The collector reads new lines by byte offset and stores them under
// their record id, so a run keeps being counted after the browser that started
// it disconnects, and a line read twice is stored once.
package usage

import (
	"context"
	"errors"
	"log"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/wellch4n/cattery/internal/db"
	"github.com/wellch4n/cattery/internal/harness"
)

// Sweep is how often ready sandboxes are polled. Runs also sync when their
// stream ends, and sandboxes sync before they stop or are destroyed.
const Sweep = 30 * time.Second

// Inline bounds a sync that deleting a session waits on, so a slow agent
// can't hold it up; lines it misses stay in the ledger for the next sync.
const Inline = 3 * time.Second

type agentURL interface {
	URL(context.Context, uuid.UUID) (string, bool)
}

type Collector struct {
	store   *db.UsageStore
	client  *harness.Client
	sandbox agentURL
	locks   sync.Map // uuid.UUID → *sync.Mutex
}

func NewCollector(store *db.UsageStore, client *harness.Client, sandbox agentURL) *Collector {
	return &Collector{store: store, client: client, sandbox: sandbox}
}

// Run sweeps ready sandboxes until ctx is done.
func (c *Collector) Run(ctx context.Context) {
	t := time.NewTicker(Sweep)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		ids, err := c.store.ReadyProjects(ctx)
		if err != nil {
			log.Printf("warn: usage sweep: %v", err)
			continue
		}
		for _, id := range ids {
			c.Sync(ctx, id)
		}
	}
}

// Sync ingests the project's new ledger lines, if its agent is reachable.
// Failures are logged: the lines stay in the ledger for the next sync.
func (c *Collector) Sync(ctx context.Context, projectID uuid.UUID) {
	v, _ := c.locks.LoadOrStore(projectID, &sync.Mutex{})
	mu := v.(*sync.Mutex)
	mu.Lock()
	defer mu.Unlock()

	base, ok := c.sandbox.URL(ctx, projectID)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	offset, err := c.store.Offset(ctx, projectID)
	if err != nil {
		log.Printf("warn: usage offset for %s: %v", projectID, err)
		return
	}
	for {
		page, err := c.client.Usage(ctx, base, offset)
		if errors.Is(err, harness.ErrNoUsageLedger) {
			return
		}
		if err != nil {
			log.Printf("warn: read usage for %s: %v", projectID, err)
			return
		}
		if page.Offset == offset && len(page.Records) == 0 {
			return
		}
		if err := c.store.Ingest(ctx, projectID, page.Records, page.Offset); err != nil {
			log.Printf("warn: ingest usage for %s: %v", projectID, err)
			return
		}
		offset = page.Offset
		if !page.More {
			return
		}
	}
}
