package weixin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/wellch4n/cattery/internal/channel"
)

// ilink fakes Tencent's iLink bot API.
type ilink struct {
	mu      sync.Mutex
	polls   int
	cursors []string
	sent    []map[string]any
	expire  bool
}

func (s *ilink) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var body map[string]any
	if r.Method == http.MethodPost {
		json.NewDecoder(r.Body).Decode(&body)
		if r.Header.Get("AuthorizationType") != "ilink_bot_token" || r.Header.Get("X-WECHAT-UIN") == "" {
			http.Error(w, "headers", http.StatusBadRequest)
			return
		}
	}
	switch r.URL.Path {
	case "/ilink/bot/get_bot_qrcode":
		json.NewEncoder(w).Encode(map[string]string{"qrcode": "q1", "qrcode_img_content": "https://liteapp.weixin.qq.com/q/x"})
	case "/ilink/bot/get_qrcode_status":
		if r.URL.Query().Get("qrcode") != "q1" {
			http.Error(w, "qrcode", http.StatusBadRequest)
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"status": "confirmed", "bot_token": "tok", "ilink_bot_id": "b@im.bot", "ilink_user_id": "u@im.wechat", "baseurl": "https://api.example"})
	case "/ilink/bot/getupdates":
		if r.Header.Get("Authorization") != "Bearer tok" {
			http.Error(w, "auth", http.StatusUnauthorized)
			return
		}
		s.cursors = append(s.cursors, body["get_updates_buf"].(string))
		s.polls++
		if s.expire {
			json.NewEncoder(w).Encode(map[string]any{"ret": -14, "errmsg": "session timeout"})
			return
		}
		msgs := []any{}
		if s.polls == 1 {
			msgs = append(msgs,
				map[string]any{"message_id": 7441535359615655688, "from_user_id": "u@im.wechat", "message_type": 1, "context_token": "ctx1",
					"item_list": []any{map[string]any{"type": 1, "text_item": map[string]string{"text": "hello"}}}},
				map[string]any{"message_id": "9", "from_user_id": "b@im.bot", "message_type": 2,
					"item_list": []any{map[string]any{"type": 1, "text_item": map[string]string{"text": "echo"}}}},
			)
		}
		json.NewEncoder(w).Encode(map[string]any{"ret": 0, "msgs": msgs, "get_updates_buf": "cur" + string(rune('0'+s.polls))})
	case "/ilink/bot/sendmessage":
		s.sent = append(s.sent, body["msg"].(map[string]any))
		json.NewEncoder(w).Encode(map[string]any{"ret": 0})
	default:
		http.NotFound(w, r)
	}
}

func TestLoginPollAndReply(t *testing.T) {
	fake := &ilink{}
	server := httptest.NewServer(fake)
	defer server.Close()
	p := New()

	// Login (pointed at the fake instead of Tencent).
	login := &Login{api: &api{http: p.http, base: server.URL}}
	var resp struct {
		reply
		QRCode string `json:"qrcode"`
		Image  string `json:"qrcode_img_content"`
	}
	if err := login.api.post(context.Background(), "/ilink/bot/get_bot_qrcode?bot_type=3", map[string]any{"local_token_list": []string{}}, &resp); err != nil {
		t.Fatal(err)
	}
	login.qrcode = resp.QRCode
	status, result, err := login.Poll(context.Background())
	if err != nil || status != LoginConfirmed || result.Token != "tok" || result.UserID != "u@im.wechat" || result.BaseURL != "https://api.example" {
		t.Fatalf("poll: %q %+v %v", status, result, err)
	}

	var states []string
	acct := &channel.Account{
		Config: channel.Config{BaseURL: server.URL, State: json.RawMessage(`{"cursor":"saved"}`)}, Secret: "tok",
		SaveState: func(_ context.Context, st json.RawMessage) error { states = append(states, string(st)); return nil },
		Connected: func() {},
	}
	conn, err := p.Open(acct)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	got := make(chan channel.Inbound, 4)
	done := make(chan error, 1)
	go func() { done <- conn.Run(ctx, func(in channel.Inbound) { got <- in }) }()
	in := <-got
	if in.Text != "hello" || in.SenderID != "u@im.wechat" || in.To.Reply != "ctx1" || in.MessageID != "7441535359615655688" {
		t.Fatalf("inbound %+v", in)
	}
	if _, err := conn.Send(context.Background(), in.To, "hi back"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	fake.mu.Lock()
	sent, cursors := fake.sent, append([]string(nil), fake.cursors...)
	fake.expire = true
	fake.mu.Unlock()
	if len(sent) != 1 || sent[0]["context_token"] != "ctx1" || sent[0]["to_user_id"] != "u@im.wechat" || sent[0]["message_type"] != float64(2) {
		t.Fatalf("sent %+v", sent)
	}
	if cursors[0] != "saved" || len(cursors) < 2 || cursors[1] != "cur1" {
		t.Fatalf("cursors %q", cursors)
	}
	// An expired token ends the connection for good.
	select {
	case err := <-done:
		if !errors.Is(err, channel.ErrExpired) {
			t.Fatalf("run ended with %v, want ErrExpired", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("run did not end")
	}
	cancel()
	if len(states) == 0 {
		t.Fatal("cursor never saved")
	}
}
