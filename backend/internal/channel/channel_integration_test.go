package channel

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/wellch4n/cattery/internal/agentrun"
	"github.com/wellch4n/cattery/internal/config"
	"github.com/wellch4n/cattery/internal/db"
	"github.com/wellch4n/cattery/internal/harness"
	"github.com/wellch4n/cattery/internal/model"
)

// freshDB creates a database of its own on TEST_DATABASE_URL (which needs
// CREATEDB), migrated, and drops it after the test.
func freshDB(t *testing.T) *sqlx.DB {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to run PostgreSQL integration tests")
	}
	root, err := sqlx.Connect("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	name := "channel_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err := root.Exec("CREATE DATABASE " + name); err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	database, err := db.Connect(u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		database.Close()
		root.Exec("DROP DATABASE " + name + " WITH (FORCE)")
		root.Close()
	})
	return database
}

// fakeAgent is pi's HTTP contract, enough for a run: every prompt is answered
// with reply and then session.idle.
type fakeAgent struct {
	reply string

	mu       sync.Mutex
	subs     []chan string
	prompts  []string
	sessions map[string]string // id → kind
}

func (a *fakeAgent) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/session":
		var body struct {
			ID   string `json:"id"`
			Kind string `json:"kind"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		a.mu.Lock()
		a.sessions[body.ID] = body.Kind
		a.mu.Unlock()
		json.NewEncoder(w).Encode(map[string]string{"id": body.ID})
	case r.URL.Path == "/event":
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		ch := make(chan string, 16)
		a.mu.Lock()
		a.subs = append(a.subs, ch)
		a.mu.Unlock()
		for {
			select {
			case <-r.Context().Done():
				return
			case frame := <-ch:
				fmt.Fprintf(w, "data: %s\n\n", frame)
				w.(http.Flusher).Flush()
			}
		}
	case strings.HasSuffix(r.URL.Path, "/prompt_async"):
		id := strings.Split(r.URL.Path, "/")[2]
		var body struct {
			Parts []struct{ Text string } `json:"parts"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		a.mu.Lock()
		a.prompts = append(a.prompts, body.Parts[0].Text)
		subs := a.subs
		a.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
		go func() {
			for i, ev := range []map[string]any{
				{"type": "message.delta", "data": map[string]string{"partId": "p1", "text": a.reply}},
				{"type": "session.idle", "data": map[string]any{}},
			} {
				ev["sessionId"], ev["seq"] = id, i+1
				b, _ := json.Marshal(ev)
				for _, s := range subs {
					s <- string(b)
				}
			}
		}()
	default:
		http.NotFound(w, r)
	}
}

type fakeSandbox struct{ url string }

func (s fakeSandbox) Await(context.Context, uuid.UUID) (string, error) { return s.url, nil }
func (s fakeSandbox) URL(context.Context, uuid.UUID) (string, bool)    { return s.url, true }

// fakePlugin hands the test each connection's inbound function and records
// what it sends.
type fakePlugin struct {
	caps    Capabilities
	inbound chan func(Inbound)

	mu   sync.Mutex
	sent []string
}

func (p *fakePlugin) Capabilities() Capabilities { return p.caps }
func (p *fakePlugin) Open(acct *Account) (Conn, error) {
	return &fakeConn{p: p, acct: acct}, nil
}

func (p *fakePlugin) waitSent(t *testing.T, n int) []string {
	t.Helper()
	for range 200 {
		p.mu.Lock()
		sent := append([]string(nil), p.sent...)
		p.mu.Unlock()
		if len(sent) >= n {
			return sent
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("want %d messages sent", n)
	return nil
}

type fakeConn struct {
	p    *fakePlugin
	acct *Account
}

func (c *fakeConn) Run(ctx context.Context, inbound func(Inbound)) error {
	c.acct.Connected()
	c.p.inbound <- inbound
	<-ctx.Done()
	return ctx.Err()
}

func (c *fakeConn) Send(_ context.Context, _ Target, text string) (string, error) {
	c.p.mu.Lock()
	defer c.p.mu.Unlock()
	c.p.sent = append(c.p.sent, text)
	return fmt.Sprint(len(c.p.sent)), nil
}

func (c *fakeConn) Edit(context.Context, Target, string, string) error { return nil }
func (c *fakeConn) Typing(context.Context, Target, bool) error         { return nil }

func TestChannelConversation(t *testing.T) {
	database := freshDB(t)
	ctx := context.Background()
	users := db.NewUserStore(database)
	creator := &model.User{Username: "creator", PasswordHash: "x"}
	if err := users.Create(ctx, creator); err != nil {
		t.Fatal(err)
	}
	name := "p"
	project := &model.Project{ProjectID: uuid.New(), OwnerUserID: creator.UserID, ProjectName: &name}
	if err := db.NewProjectStore(database).Create(ctx, project); err != nil {
		t.Fatal(err)
	}

	box, _ := NewSecretBox("test-key")
	store := db.NewChannelStore(database)
	cfg, _ := json.Marshal(Config{ExternalID: "bot@im.bot", Secret: box.Seal("token"), OwnerExternalID: "owner@im.wechat"})
	ch := &model.Channel{ChannelID: uuid.New(), ProjectID: project.ProjectID, Type: TypeWeixin, Name: "WeChat",
		Model: "test", Effort: "high", Config: cfg, Enabled: true, Status: StatusConnecting, CreatedByUserID: creator.UserID}
	if err := store.Create(ctx, ch); err != nil {
		t.Fatal(err)
	}
	if ch.CreatedByUsername != "creator" {
		t.Fatalf("creator not read back: %+v", ch)
	}
	// One bot, one channel.
	dup := *ch
	dup.ChannelID = uuid.New()
	if err := store.Create(ctx, &dup); err == nil {
		t.Fatal("a second channel for the same bot was accepted")
	}

	agent := &fakeAgent{reply: "Hello **there**", sessions: map[string]string{}}
	server := httptest.NewServer(agent)
	defer server.Close()
	models := &config.Models{Default: "test", Providers: []config.Provider{{Type: "custom", Endpoint: "http://model", Key: "k", Models: []string{"test"}, Efforts: []string{"high"}}}}
	plugin := &fakePlugin{caps: Capabilities{TextLimit: 2000}, inbound: make(chan func(Inbound), 1)}
	m := NewManager(store, box, map[string]Plugin{TypeWeixin: plugin},
		&agentrun.Runner{Harness: harnessClient(), Sandbox: fakeSandbox{server.URL}, Models: models},
		nil, func(uuid.UUID) {}, func(context.Context, uuid.UUID, uuid.UUID) bool { return true })
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go m.Run(runCtx)
	inbound := <-plugin.inbound

	// The plugin's state and the owner's edits never overwrite each other.
	if err := store.SetState(ctx, ch.ChannelID, json.RawMessage(`{"cursor":"c1"}`)); err != nil {
		t.Fatal(err)
	}
	if err := store.MergeConfig(ctx, ch.ChannelID, map[string]any{"base_url": "https://x"}); err != nil {
		t.Fatal(err)
	}
	got, _ := store.Get(ctx, ch.ChannelID)
	var saved Config
	json.Unmarshal(got.Config, &saved)
	if string(saved.State) != `{"cursor": "c1"}` || saved.BaseURL != "https://x" || saved.OwnerExternalID != "owner@im.wechat" {
		t.Fatalf("config lost a key: %s", got.Config)
	}
	if got.Status != StatusConnected {
		t.Fatalf("status %q, want connected", got.Status)
	}

	// Strangers are ignored; the owner's message runs the channel's conversation.
	inbound(Inbound{MessageID: "1", SenderID: "stranger@im.wechat", Text: "hi", To: Target{ChatID: "stranger@im.wechat"}})
	inbound(Inbound{MessageID: "2", SenderID: "owner@im.wechat", Text: "fix login", To: Target{ChatID: "owner@im.wechat"}})
	inbound(Inbound{MessageID: "2", SenderID: "owner@im.wechat", Text: "fix login", To: Target{ChatID: "owner@im.wechat"}})
	sent := plugin.waitSent(t, 1)
	if sent[0] != "Hello there" {
		t.Fatalf("sent %q", sent)
	}
	time.Sleep(200 * time.Millisecond)
	agent.mu.Lock()
	prompts, kind := agent.prompts, agent.sessions[ch.ChannelID.String()]
	agent.mu.Unlock()
	if len(prompts) != 1 || prompts[0] != "fix login" {
		t.Fatalf("prompts %q", prompts)
	}
	if kind != "channel" {
		t.Fatalf("registered as %q, want channel", kind)
	}

	// The channel's tokens are charged to its creator.
	usage := db.NewUsageStore(database)
	if err := usage.Ingest(ctx, project.ProjectID, []model.UsageRecord{{ID: "r1", SessionID: ch.ChannelID, At: time.Now().UnixMilli(), Kind: "reply", Model: "test", Output: 5}}, 10); err != nil {
		t.Fatal(err)
	}
	var charged uuid.UUID
	if err := database.Get(&charged, `SELECT user_id FROM usage_records WHERE record_id='r1'`); err != nil || charged != creator.UserID {
		t.Fatalf("charged %s (%v), want %s", charged, err, creator.UserID)
	}
}

func TestBotOwnerBindsWithTheCode(t *testing.T) {
	database := freshDB(t)
	ctx := context.Background()
	creator := &model.User{Username: "creator", PasswordHash: "x"}
	if err := db.NewUserStore(database).Create(ctx, creator); err != nil {
		t.Fatal(err)
	}
	name := "p"
	project := &model.Project{ProjectID: uuid.New(), OwnerUserID: creator.UserID, ProjectName: &name}
	if err := db.NewProjectStore(database).Create(ctx, project); err != nil {
		t.Fatal(err)
	}
	box, _ := NewSecretBox("test-key")
	store := db.NewChannelStore(database)
	cfg, _ := json.Marshal(Config{ExternalID: "cli_x", Secret: box.Seal("s"), BindCode: "123456"})
	ch := &model.Channel{ChannelID: uuid.New(), ProjectID: project.ProjectID, Type: TypeLark, Name: "Lark",
		Model: "test", Config: cfg, Enabled: true, Status: StatusConnecting, CreatedByUserID: creator.UserID}
	if err := store.Create(ctx, ch); err != nil {
		t.Fatal(err)
	}
	plugin := &fakePlugin{caps: Capabilities{EditMessage: true, TextLimit: 2000, Markdown: true}, inbound: make(chan func(Inbound), 1)}
	m := NewManager(store, box, map[string]Plugin{TypeLark: plugin}, &agentrun.Runner{}, nil, func(uuid.UUID) {}, nil)
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go m.Run(runCtx)
	inbound := <-plugin.inbound

	inbound(Inbound{MessageID: "1", SenderID: "on_a", Text: "/bind 000000"})
	inbound(Inbound{MessageID: "2", SenderID: "on_a", Text: "/bind 123456"})
	plugin.waitSent(t, 1)
	got, _ := store.Get(ctx, ch.ChannelID)
	var saved Config
	json.Unmarshal(got.Config, &saved)
	if saved.OwnerExternalID != "on_a" || saved.BindCode != "" {
		t.Fatalf("not bound: %s", got.Config)
	}
	// Bound: the code is spent, and others are still ignored.
	inbound(Inbound{MessageID: "3", SenderID: "on_b", Text: "/bind 123456"})
	inbound(Inbound{MessageID: "4", SenderID: "on_a", Text: "/help"})
	sent := plugin.waitSent(t, 2)
	time.Sleep(100 * time.Millisecond)
	if len(sent) != 2 || !strings.Contains(sent[1], "/stop") {
		t.Fatalf("sent %q", sent)
	}
}

func harnessClient() *harness.Client { return harness.NewClient() }
