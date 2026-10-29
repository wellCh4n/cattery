// Package larksuite is what the Feishu and Lark channel plugins share. The two
// are separate platforms (their own apps, accounts and hosts) with one API,
// which this package speaks to on a given base URL; packages feishu and lark
// pin it to theirs. A self-built app's bot receives events over the long
// connection, which the backend dials out to, so no public callback URL is
// needed. Replies are message cards edited in place while they stream. Only
// direct messages are taken, and only from the channel's owner, who binds by
// sending the bot "/bind <code>".
package larksuite

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	lark "github.com/larksuite/oapi-sdk-go/v3"
	larkcore "github.com/larksuite/oapi-sdk-go/v3/core"
	"github.com/larksuite/oapi-sdk-go/v3/event/dispatcher"
	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
	larkws "github.com/larksuite/oapi-sdk-go/v3/ws"
	"github.com/wellch4n/cattery/internal/channel"
)

// A card's JSON must stay under 30 KB; Markdown leaves room for escaping.
const textLimit = 12000

// Plugin speaks to the platform at one base URL.
type Plugin struct{ base string }

// New speaks to the platform at baseURL (e.g. https://open.feishu.cn).
func New(baseURL string) *Plugin { return &Plugin{baseURL} }

func (p *Plugin) Capabilities() channel.Capabilities {
	return channel.Capabilities{EditMessage: true, TextLimit: textLimit, Markdown: true}
}

func (p *Plugin) Open(acct *channel.Account) (channel.Conn, error) {
	if acct.Config.ExternalID == "" || acct.Secret == "" {
		return nil, errors.New("app id and secret are required")
	}
	return &conn{
		acct: acct, base: p.base,
		api: lark.NewClient(acct.Config.ExternalID, acct.Secret, lark.WithOpenBaseUrl(p.base), lark.WithLogLevel(larkcore.LogLevelError)),
	}, nil
}

type conn struct {
	acct *channel.Account
	base string
	api  *lark.Client
}

// Mentions arrive as placeholders like "@_user_1".
var mention = regexp.MustCompile(`@_user_\d+\s*`)

func (c *conn) Run(ctx context.Context, inbound func(channel.Inbound)) error {
	events := dispatcher.NewEventDispatcher("", "").OnP2MessageReceiveV1(func(_ context.Context, ev *larkim.P2MessageReceiveV1) error {
		if ev.Event == nil || ev.Event.Message == nil || ev.Event.Sender == nil || ev.Event.Sender.SenderId == nil {
			return nil
		}
		m := ev.Event.Message
		if str(m.ChatType) != "p2p" || str(m.MessageType) != "text" || str(ev.Event.Sender.SenderType) != "user" {
			return nil
		}
		var content struct {
			Text string `json:"text"`
		}
		if json.Unmarshal([]byte(str(m.Content)), &content) != nil {
			return nil
		}
		inbound(channel.Inbound{
			MessageID: str(m.MessageId),
			SenderID:  str(ev.Event.Sender.SenderId.UnionId),
			Text:      strings.TrimSpace(mention.ReplaceAllString(content.Text, "")),
			To:        channel.Target{ChatID: str(m.ChatId)},
		})
		return nil
	})
	ws := larkws.NewClient(c.acct.Config.ExternalID, c.acct.Secret,
		larkws.WithEventHandler(events),
		larkws.WithDomain(c.base),
		larkws.WithLogLevel(larkcore.LogLevelError),
		larkws.WithOnReady(c.acct.Connected),
	)
	return ws.Start(ctx)
}

// card wraps Markdown in a message card that can be edited later.
func card(text string) string {
	b, _ := json.Marshal(map[string]any{
		"config":   map[string]any{"wide_screen_mode": true, "update_multi": true},
		"elements": []any{map[string]any{"tag": "markdown", "content": text}},
	})
	return string(b)
}

func (c *conn) Send(ctx context.Context, to channel.Target, text string) (string, error) {
	resp, err := c.api.Im.V1.Message.Create(ctx, larkim.NewCreateMessageReqBuilder().
		ReceiveIdType("chat_id").
		Body(larkim.NewCreateMessageReqBodyBuilder().ReceiveId(to.ChatID).MsgType("interactive").Content(card(text)).Build()).
		Build())
	if err != nil {
		return "", err
	}
	if !resp.Success() {
		return "", fmt.Errorf("send: %d %s", resp.Code, resp.Msg)
	}
	return str(resp.Data.MessageId), nil
}

func (c *conn) Edit(ctx context.Context, _ channel.Target, messageID, text string) error {
	resp, err := c.api.Im.V1.Message.Patch(ctx, larkim.NewPatchMessageReqBuilder().
		MessageId(messageID).
		Body(larkim.NewPatchMessageReqBodyBuilder().Content(card(text)).Build()).
		Build())
	if err != nil {
		return err
	}
	if !resp.Success() {
		return fmt.Errorf("edit: %d %s", resp.Code, resp.Msg)
	}
	return nil
}

// Typing: there is no typing indicator; the streaming card shows progress.
func (c *conn) Typing(context.Context, channel.Target, bool) error { return nil }

// Validate checks an app's credentials and returns its bot's name.
func (p *Plugin) Validate(ctx context.Context, appID, secret string) (string, error) {
	client := lark.NewClient(appID, secret, lark.WithOpenBaseUrl(p.base), lark.WithLogLevel(larkcore.LogLevelError))
	resp, err := client.Get(ctx, "/open-apis/bot/v3/info", nil, larkcore.AccessTokenTypeTenant)
	if err != nil {
		return "", fmt.Errorf("the App ID and App Secret were not accepted (%w)", err)
	}
	var info struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
		Bot  struct {
			Name string `json:"app_name"`
		} `json:"bot"`
	}
	if err := json.Unmarshal(resp.RawBody, &info); err != nil {
		return "", fmt.Errorf("bot info: %w", err)
	}
	if info.Code != 0 {
		return "", fmt.Errorf("%s (%d); is the app's bot enabled?", info.Msg, info.Code)
	}
	return info.Bot.Name, nil
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
