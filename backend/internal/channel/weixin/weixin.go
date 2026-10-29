// Package weixin is the WeChat ClawBot channel plugin. It speaks Tencent's
// iLink bot API (the one OpenClaw's openclaw-weixin plugin uses): a QR login
// yields a bot token, messages arrive by long-polling getupdates, and every
// reply carries the context_token of a message it answers — a bot cannot
// message first. The account belongs to whoever scanned the code, and only
// their messages are taken.
package weixin

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/wellch4n/cattery/internal/channel"
)

// DefaultBaseURL is where logins start; a login names the account's own.
const DefaultBaseURL = "https://ilinkai.weixin.qq.com"

const (
	channelVersion = "2.4.6"
	botAgent       = "Cattery/1.0"
	pollTimeout    = 45 * time.Second
	// Replies are plain text; WeChat does not render Markdown.
	textLimit = 2000
)

// errSessionExpired is iLink's code for a token that no longer works.
const errSessionExpired = -14

type Plugin struct{ http *http.Client }

func New() *Plugin { return &Plugin{http: &http.Client{}} }

func (p *Plugin) Capabilities() channel.Capabilities {
	return channel.Capabilities{EditMessage: false, TextLimit: textLimit, Markdown: false}
}

// state is what the account keeps across restarts.
type state struct {
	// Cursor is getupdates' get_updates_buf, saved only after a good response.
	Cursor string `json:"cursor"`
}

func (p *Plugin) Open(acct *channel.Account) (channel.Conn, error) {
	base := acct.Config.BaseURL
	if base == "" {
		base = DefaultBaseURL
	}
	var st state
	if len(acct.Config.State) > 0 {
		_ = json.Unmarshal(acct.Config.State, &st)
	}
	return &conn{api: &api{http: p.http, base: strings.TrimRight(base, "/"), token: acct.Secret}, acct: acct, state: st, tickets: map[string]string{}}, nil
}

type conn struct {
	api   *api
	acct  *channel.Account
	state state

	mu      sync.Mutex
	tickets map[string]string // typing tickets, by user
}

// message is an inbound or outbound iLink message.
type message struct {
	MessageID    flexID `json:"message_id,omitempty"`
	Seq          flexID `json:"seq,omitempty"`
	FromUserID   string `json:"from_user_id"`
	ToUserID     string `json:"to_user_id"`
	ClientID     string `json:"client_id,omitempty"`
	MessageType  int    `json:"message_type"`
	MessageState int    `json:"message_state"`
	ContextToken string `json:"context_token,omitempty"`
	CreateTimeMS flexID `json:"create_time_ms,omitempty"`
	Items        []item `json:"item_list"`
}

// flexID reads an id sent as a JSON number or string.
type flexID string

func (f *flexID) UnmarshalJSON(b []byte) error {
	*f = flexID(strings.Trim(string(b), `"`))
	if *f == "null" {
		*f = ""
	}
	return nil
}

type item struct {
	Type  int        `json:"type"`
	Text  *textItem  `json:"text_item,omitempty"`
	Voice *voiceItem `json:"voice_item,omitempty"`
}

type textItem struct {
	Text string `json:"text"`
}

type voiceItem struct {
	// Text is WeChat's transcription of the voice message.
	Text string `json:"text,omitempty"`
}

const (
	typeUser    = 1
	typeBot     = 2
	stateFinish = 2
	itemText    = 1
	itemVoice   = 3
)

func (c *conn) Run(ctx context.Context, inbound func(channel.Inbound)) error {
	connected := false
	for {
		var resp struct {
			reply
			Msgs    []message `json:"msgs"`
			Cursor  string    `json:"get_updates_buf"`
			Timeout int       `json:"longpolling_timeout_ms"`
		}
		pollCtx, cancel := context.WithTimeout(ctx, pollTimeout)
		err := c.api.post(pollCtx, "/ilink/bot/getupdates", map[string]any{"get_updates_buf": c.state.Cursor}, &resp)
		cancel()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if errors.Is(err, context.DeadlineExceeded) {
			continue // the long poll ran out: ask again
		}
		if err != nil {
			return err
		}
		if !connected {
			connected = true
			c.acct.Connected()
		}
		for _, m := range resp.Msgs {
			if m.MessageType != typeUser {
				continue
			}
			var text []string
			for _, it := range m.Items {
				switch {
				case it.Type == itemText && it.Text != nil:
					text = append(text, it.Text.Text)
				case it.Type == itemVoice && it.Voice != nil && it.Voice.Text != "":
					text = append(text, it.Voice.Text)
				}
			}
			if len(text) == 0 {
				continue
			}
			id := string(m.MessageID)
			if id == "" {
				id = m.FromUserID + ":" + string(m.Seq) + ":" + string(m.CreateTimeMS)
			}
			inbound(channel.Inbound{
				MessageID: id, SenderID: m.FromUserID, Text: strings.Join(text, "\n"),
				To: channel.Target{ChatID: m.FromUserID, Reply: m.ContextToken},
			})
		}
		if resp.Cursor != "" && resp.Cursor != c.state.Cursor {
			c.state.Cursor = resp.Cursor
			b, _ := json.Marshal(c.state)
			saveCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			_ = c.acct.SaveState(saveCtx, b)
			cancel()
		}
	}
}

func (c *conn) Send(ctx context.Context, to channel.Target, text string) (string, error) {
	clientID := "cattery-" + uuid.NewString()
	var resp reply
	err := c.api.post(ctx, "/ilink/bot/sendmessage", map[string]any{"msg": message{
		ToUserID: to.ChatID, ClientID: clientID, MessageType: typeBot, MessageState: stateFinish,
		ContextToken: to.Reply, Items: []item{{Type: itemText, Text: &textItem{Text: text}}},
	}}, &resp)
	return clientID, err
}

func (c *conn) Edit(context.Context, channel.Target, string, string) error {
	return errors.New("weixin messages cannot be edited")
}

// Typing shows "typing…" while a reply is on its way; failures are harmless.
func (c *conn) Typing(ctx context.Context, to channel.Target, on bool) error {
	c.mu.Lock()
	ticket := c.tickets[to.ChatID]
	c.mu.Unlock()
	if ticket == "" {
		var resp struct {
			reply
			Ticket string `json:"typing_ticket"`
		}
		if err := c.api.post(ctx, "/ilink/bot/getconfig", map[string]any{"ilink_user_id": to.ChatID, "context_token": to.Reply}, &resp); err != nil {
			return err
		}
		if resp.Ticket == "" {
			return errors.New("no typing ticket")
		}
		ticket = resp.Ticket
		c.mu.Lock()
		c.tickets[to.ChatID] = ticket
		c.mu.Unlock()
	}
	status := 2
	if on {
		status = 1
	}
	return c.api.post(ctx, "/ilink/bot/sendtyping", map[string]any{"ilink_user_id": to.ChatID, "typing_ticket": ticket, "status": status}, nil)
}

// reply is the status every iLink response carries.
type reply struct {
	Ret     *int   `json:"ret"`
	ErrCode int    `json:"errcode"`
	ErrMsg  string `json:"errmsg"`
}

func (r *reply) failure() error {
	ret := 0
	if r.Ret != nil {
		ret = *r.Ret
	}
	if ret == errSessionExpired || r.ErrCode == errSessionExpired {
		return channel.ErrExpired
	}
	if ret != 0 || r.ErrCode != 0 {
		return fmt.Errorf("weixin: ret %d errcode %d %s", ret, r.ErrCode, r.ErrMsg)
	}
	return nil
}

type failer interface{ failure() error }

type api struct {
	http  *http.Client
	base  string
	token string
}

func uin() string {
	return base64.StdEncoding.EncodeToString([]byte(strconv.FormatUint(uint64(rand.Uint32()), 10)))
}

func (a *api) post(ctx context.Context, path string, body map[string]any, out any) error {
	body["base_info"] = map[string]string{"channel_version": channelVersion, "bot_agent": botAgent}
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.base+path, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("AuthorizationType", "ilink_bot_token")
	req.Header.Set("X-WECHAT-UIN", uin())
	req.Header.Set("iLink-App-Id", "bot")
	req.Header.Set("iLink-App-ClientVersion", "132102")
	if a.token != "" {
		req.Header.Set("Authorization", "Bearer "+a.token)
	}
	return a.do(req, out)
}

func (a *api) do(req *http.Request, out any) error {
	resp, err := a.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return fmt.Errorf("weixin %s: status %d: %s", req.URL.Path, resp.StatusCode, bytes.TrimSpace(data))
	}
	if out == nil {
		var r reply
		if json.Unmarshal(data, &r) == nil {
			return r.failure()
		}
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if err := dec.Decode(out); err != nil {
		return fmt.Errorf("weixin %s: %w", req.URL.Path, err)
	}
	if f, ok := out.(failer); ok {
		return f.failure()
	}
	return nil
}

// Login is a QR login in progress.
type Login struct {
	api    *api
	qrcode string
	// QR is what the QR code encodes: a link the WeChat app opens.
	QR     string
	tokens []string

	mu       sync.Mutex
	verify   string
	verified bool
}

// LoginResult is a confirmed login.
type LoginResult struct {
	Token   string
	BotID   string
	UserID  string
	BaseURL string
}

// Login statuses Wait reports, besides confirmed.
const (
	LoginWaiting    = "wait"
	LoginScanned    = "scaned"
	LoginVerify     = "need_verifycode"
	LoginBlocked    = "verify_code_blocked"
	LoginExpired    = "expired"
	LoginConfirmed  = "confirmed"
	loginRedirect   = "scaned_but_redirect"
	loginRebound    = "binded_redirect"
	defaultLoginTTL = 5 * time.Minute
)

// StartLogin asks for a login QR code. tokens are bot tokens this backend
// already holds, so a WeChat already bound here can be recognized.
func (p *Plugin) StartLogin(ctx context.Context, tokens []string) (*Login, error) {
	a := &api{http: p.http, base: DefaultBaseURL}
	if tokens == nil {
		tokens = []string{}
	}
	var resp struct {
		reply
		QRCode string `json:"qrcode"`
		Image  string `json:"qrcode_img_content"`
	}
	if err := a.post(ctx, "/ilink/bot/get_bot_qrcode?bot_type=3", map[string]any{"local_token_list": tokens}, &resp); err != nil {
		return nil, err
	}
	if resp.QRCode == "" || resp.Image == "" {
		return nil, errors.New("weixin: no QR code in the response")
	}
	return &Login{api: a, qrcode: resp.QRCode, QR: resp.Image, tokens: tokens}, nil
}

// Verify supplies the code WeChat shows on the phone after need_verifycode.
func (l *Login) Verify(code string) {
	l.mu.Lock()
	l.verify, l.verified = strings.TrimSpace(code), false
	l.mu.Unlock()
}

// Poll waits (up to the server's hold) for the login to move on, returning
// its status, and the account once confirmed.
func (l *Login) Poll(ctx context.Context) (string, *LoginResult, error) {
	q := url.Values{"qrcode": {l.qrcode}}
	l.mu.Lock()
	if l.verify != "" && !l.verified {
		q.Set("verify_code", l.verify)
		l.verified = true
	}
	l.mu.Unlock()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, l.api.base+"/ilink/bot/get_qrcode_status?"+q.Encode(), nil)
	if err != nil {
		return "", nil, err
	}
	req.Header.Set("iLink-App-Id", "bot")
	req.Header.Set("iLink-App-ClientVersion", "132102")
	var resp struct {
		reply
		Status       string `json:"status"`
		Token        string `json:"bot_token"`
		BotID        string `json:"ilink_bot_id"`
		UserID       string `json:"ilink_user_id"`
		BaseURL      string `json:"baseurl"`
		RedirectHost string `json:"redirect_host"`
	}
	if err := l.api.do(req, &resp); err != nil {
		return "", nil, err
	}
	switch resp.Status {
	case loginRedirect:
		if resp.RedirectHost != "" {
			l.api.base = "https://" + strings.TrimSuffix(strings.TrimPrefix(resp.RedirectHost, "https://"), "/")
		}
		return LoginScanned, nil, nil
	case loginRebound:
		return LoginConfirmed, nil, errors.New("this WeChat is already connected to a channel here")
	case LoginConfirmed:
		if resp.Token == "" || resp.BotID == "" || resp.UserID == "" {
			return "", nil, errors.New("weixin: incomplete login")
		}
		base := resp.BaseURL
		if base == "" {
			base = DefaultBaseURL
		}
		return LoginConfirmed, &LoginResult{Token: resp.Token, BotID: resp.BotID, UserID: resp.UserID, BaseURL: base}, nil
	case "":
		return LoginWaiting, nil, nil
	}
	return resp.Status, nil, nil
}

// LoginTTL is how long a QR code stays usable.
func LoginTTL() time.Duration { return defaultLoginTTL }
