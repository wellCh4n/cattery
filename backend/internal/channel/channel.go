// Package channel connects chat platforms to projects. A channel plugin (a
// subpackage: feishu, weixin) speaks one platform; a channel is one account on
// it (a Feishu or Lark bot, a WeChat ClawBot login), bound to a project. Each channel
// is one agent conversation owned by its creator, whose agent id is the
// channel id; only its owner's messages reach it.
//
// The core owns what is the same everywhere: the connections' lifecycle
// (Manager), the inbound pipeline (dispatcher) and turning platform events
// into chat messages (renderer). Plugins own transport, login and formatting.
package channel

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
)

// Channel types, one per plugin.
const (
	TypeFeishu = "feishu"
	TypeLark   = "lark" // Feishu's international edition, a separate platform
	TypeWeixin = "weixin"
)

// Connection health, stored in channels.status.
const (
	StatusConnecting = "connecting"
	StatusConnected  = "connected"
	StatusExpired    = "expired" // the login must be renewed (WeChat: scan again)
	StatusError      = "error"
	StatusDisabled   = "disabled"
)

// ErrExpired is returned by Conn.Run when the account's login no longer works
// and retrying cannot fix it.
var ErrExpired = errors.New("login expired")

// Config is a channel's config column. Each writer replaces only its own keys.
type Config struct {
	// ExternalID names the account on its platform: a Feishu or Lark app id, a WeChat
	// ilink_bot_id. One account backs one channel.
	ExternalID string `json:"external_id"`
	// Secret is sealed (see SecretBox): a Feishu or Lark app secret, a WeChat bot token.
	Secret string `json:"secret"`
	// OwnerExternalID is the creator's id on the platform; nobody else's
	// messages are taken. WeChat knows it from the login; Feishu and Lark learn it
	// from the first "/bind <BindCode>" sent to the bot.
	OwnerExternalID string `json:"owner_external_id,omitempty"`
	BindCode        string `json:"bind_code,omitempty"`
	// BaseURL is where WeChat's login sends the account's API calls.
	BaseURL string `json:"base_url,omitempty"`
	// State is the plugin's own (WeChat: the update cursor, reply tokens).
	State json.RawMessage `json:"state,omitempty"`
}

// Account is what a plugin connects.
type Account struct {
	ID     uuid.UUID
	Config Config
	// Secret is Config.Secret opened.
	Secret string
	// SaveState persists the plugin's state; call it from Run's goroutine only.
	SaveState func(context.Context, json.RawMessage) error
	// Connected reports that the connection is up.
	Connected func()
}

// Inbound is one message from the chat.
type Inbound struct {
	// MessageID identifies the message, to drop redeliveries.
	MessageID string
	SenderID  string
	Text      string
	To        Target
}

// Target says where a reply goes.
type Target struct {
	ChatID string
	// Reply is the plugin's reply context (WeChat's context_token).
	Reply string
}

// Capabilities say how replies are rendered.
type Capabilities struct {
	// EditMessage: a reply is one message edited while it streams (preview).
	// Otherwise it is sent in finished blocks.
	EditMessage bool
	// TextLimit caps a message, in bytes.
	TextLimit int
	// Markdown: the platform renders Markdown; else replies are plain text.
	Markdown bool
}

// Plugin speaks one platform.
type Plugin interface {
	Capabilities() Capabilities
	Open(acct *Account) (Conn, error)
}

// Conn is one connected account.
type Conn interface {
	// Run receives messages until ctx ends or the connection fails.
	Run(ctx context.Context, inbound func(Inbound)) error
	Send(ctx context.Context, to Target, text string) (messageID string, err error)
	// Edit replaces a sent message's text; only with Capabilities.EditMessage.
	Edit(ctx context.Context, to Target, messageID, text string) error
	// Typing shows or hides a typing indicator, where the platform has one.
	Typing(ctx context.Context, to Target, on bool) error
}
