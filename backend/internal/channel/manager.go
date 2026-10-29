package channel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/wellch4n/cattery/internal/agentrun"
	"github.com/wellch4n/cattery/internal/db"
	"github.com/wellch4n/cattery/internal/model"
)

const reconcileEvery = 30 * time.Second

// Manager keeps every enabled channel connected: one goroutine per channel,
// reconnecting with backoff. The backend runs as a single replica, so each
// connection has one owner. A channel whose login expired, or whose secret
// cannot be opened, waits for Reload instead of retrying.
type Manager struct {
	store   *db.ChannelStore
	box     *SecretBox
	plugins map[string]Plugin
	runner  *agentrun.Runner
	usage   func(context.Context, uuid.UUID)
	// publish tells the project's members its channels changed.
	publish func(projectID uuid.UUID)
	// member reports whether a user still belongs to a project; a channel
	// whose creator left it stops answering.
	member func(ctx context.Context, projectID, userID uuid.UUID) bool

	mu      sync.Mutex
	ctx     context.Context
	workers map[uuid.UUID]*worker
}

type worker struct {
	projectID uuid.UUID
	cancel    context.CancelFunc
	done      chan struct{}
}

// NewManager makes a Manager. box is nil when CHANNEL_SECRET_KEY is unset:
// channels are then off.
func NewManager(store *db.ChannelStore, box *SecretBox, plugins map[string]Plugin, runner *agentrun.Runner,
	usage func(context.Context, uuid.UUID), publish func(uuid.UUID), member func(context.Context, uuid.UUID, uuid.UUID) bool) *Manager {
	return &Manager{store: store, box: box, plugins: plugins, runner: runner, usage: usage, publish: publish, member: member, workers: map[uuid.UUID]*worker{}}
}

// StopProject disconnects a project's channels, before the project goes.
func (m *Manager) StopProject(projectID uuid.UUID) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, w := range m.workers {
		if w.projectID == projectID {
			m.stopLocked(id)
		}
	}
}

// Enabled reports whether channels can be used (a secret key is configured).
func (m *Manager) Enabled() bool { return m.box != nil }

// Seal seals a secret for a channel's config.
func (m *Manager) Seal(secret string) string { return m.box.Seal(secret) }

// Run connects the enabled channels, and reconciles with the table until ctx ends.
func (m *Manager) Run(ctx context.Context) {
	if !m.Enabled() {
		log.Printf("channels are off: set CHANNEL_SECRET_KEY to connect Feishu and WeChat")
		return
	}
	m.mu.Lock()
	m.ctx = ctx
	m.mu.Unlock()
	t := time.NewTicker(reconcileEvery)
	defer t.Stop()
	for {
		m.reconcile()
		select {
		case <-ctx.Done():
			m.mu.Lock()
			for id := range m.workers {
				m.stopLocked(id)
			}
			m.mu.Unlock()
			return
		case <-t.C:
		}
	}
}

// reconcile starts channels enabled since and stops those deleted or
// disabled (a project deletion removes its channels without telling us).
func (m *Manager) reconcile() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	channels, err := m.store.ListEnabled(ctx)
	if err != nil {
		log.Printf("channels: list: %v", err)
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	keep := map[uuid.UUID]bool{}
	for _, ch := range channels {
		keep[ch.ChannelID] = true
		if _, running := m.workers[ch.ChannelID]; !running && ch.Status != StatusExpired {
			m.startLocked(ch)
		}
	}
	for id := range m.workers {
		if !keep[id] {
			m.stopLocked(id)
		}
	}
}

// Reload reconnects a channel after it changed (or stops it, if it is gone
// or disabled).
func (m *Manager) Reload(id uuid.UUID) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ch, err := m.store.Get(ctx, id)
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stopLocked(id)
	if err != nil || m.ctx == nil {
		return
	}
	if !ch.Enabled {
		m.setStatus(ch, StatusDisabled, nil)
		return
	}
	m.startLocked(ch)
}

// Stop disconnects a channel and waits for its runs to end.
func (m *Manager) Stop(id uuid.UUID) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stopLocked(id)
}

func (m *Manager) stopLocked(id uuid.UUID) {
	w := m.workers[id]
	if w == nil {
		return
	}
	delete(m.workers, id)
	w.cancel()
	select {
	case <-w.done:
	case <-time.After(5 * time.Second):
		log.Printf("channel %s: still stopping", id)
	}
}

func (m *Manager) startLocked(ch *model.Channel) {
	ctx, cancel := context.WithCancel(m.ctx)
	w := &worker{projectID: ch.ProjectID, cancel: cancel, done: make(chan struct{})}
	m.workers[ch.ChannelID] = w
	go m.work(ctx, ch, w)
}

// errPermanent marks failures retrying cannot fix.
type errPermanent struct{ error }

func (m *Manager) work(ctx context.Context, ch *model.Channel, w *worker) {
	defer close(w.done)
	backoff := time.Second
	for {
		began := time.Now()
		err := m.connect(ctx, ch)
		if ctx.Err() != nil {
			return
		}
		var permanent errPermanent
		switch {
		case errors.Is(err, ErrExpired):
			m.setStatus(ch, StatusExpired, err)
			return
		case errors.As(err, &permanent):
			m.setStatus(ch, StatusError, err)
			return
		}
		if err == nil {
			err = errors.New("disconnected")
		}
		log.Printf("channel %s: %v; reconnecting in %s", ch.ChannelID, err, backoff)
		m.setStatus(ch, StatusError, err)
		if time.Since(began) > time.Minute {
			backoff = time.Second
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, time.Minute)
	}
}

func (m *Manager) connect(ctx context.Context, ch *model.Channel) error {
	plugin := m.plugins[ch.Type]
	if plugin == nil {
		return errPermanent{fmt.Errorf("unknown channel type %q", ch.Type)}
	}
	var cfg Config
	if err := json.Unmarshal(ch.Config, &cfg); err != nil {
		return errPermanent{err}
	}
	secret, err := m.box.Open(cfg.Secret)
	if err != nil {
		return errPermanent{err}
	}
	acct := &Account{
		ID: ch.ChannelID, Config: cfg, Secret: secret,
		SaveState: func(ctx context.Context, state json.RawMessage) error {
			return m.store.SetState(ctx, ch.ChannelID, state)
		},
		Connected: func() { m.setStatus(ch, StatusConnected, nil) },
	}
	conn, err := plugin.Open(acct)
	if err != nil {
		return errPermanent{err}
	}
	d := &dispatcher{
		m: m, id: ch.ChannelID, ctx: ctx, conn: conn, caps: plugin.Capabilities(),
		seen: newRecent(512), owner: cfg.OwnerExternalID, bindCode: cfg.BindCode,
	}
	m.setStatus(ch, StatusConnecting, nil)
	return conn.Run(ctx, d.inbound)
}

func (m *Manager) setStatus(ch *model.Channel, status string, err error) {
	var msg *string
	if err != nil {
		s := err.Error()
		msg = &s
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	changed, serr := m.store.SetStatus(ctx, ch.ChannelID, status, msg)
	if serr != nil {
		log.Printf("channel %s: save status: %v", ch.ChannelID, serr)
		return
	}
	if changed {
		m.publish(ch.ProjectID)
	}
}

// changed tells a channel's project its channels changed.
func (m *Manager) changed(id uuid.UUID) {
	m.mu.Lock()
	w := m.workers[id]
	m.mu.Unlock()
	if w != nil {
		m.publish(w.projectID)
	}
}

func (m *Manager) syncUsage(projectID uuid.UUID) {
	if m.usage != nil {
		go m.usage(context.Background(), projectID)
	}
}
