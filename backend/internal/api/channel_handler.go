package api

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/lib/pq"
	qrcode "github.com/skip2/go-qrcode"
	"github.com/wellch4n/cattery/internal/agentrun"
	"github.com/wellch4n/cattery/internal/channel"
	"github.com/wellch4n/cattery/internal/channel/larksuite"
	"github.com/wellch4n/cattery/internal/channel/weixin"
	"github.com/wellch4n/cattery/internal/db"
	"github.com/wellch4n/cattery/internal/harness"
	"github.com/wellch4n/cattery/internal/live"
	"github.com/wellch4n/cattery/internal/model"
	"github.com/wellch4n/cattery/internal/usage"
)

// ChannelHandler serves chat channels: their settings and logins, and their
// conversation for the channel tab, which works like a session's (history,
// following, sending, forking) under /channels/:channel_id. Any member reads
// a project's channels; only a channel's creator talks to it or changes it,
// and the project owner may also delete it.
type ChannelHandler struct {
	channels *db.ChannelStore
	projects *db.ProjectStore
	sessions *SessionHandler
	manager  *channel.Manager
	// bots are the Feishu and Lark plugins, by channel type.
	bots   map[string]*larksuite.Plugin
	weixin *weixin.Plugin
	live   *live.Hub

	mu     sync.Mutex
	logins map[uuid.UUID]*weixinLogin
}

func NewChannelHandler(channels *db.ChannelStore, projects *db.ProjectStore, sessions *SessionHandler, manager *channel.Manager, bots map[string]*larksuite.Plugin, wx *weixin.Plugin, hub *live.Hub) *ChannelHandler {
	return &ChannelHandler{channels: channels, projects: projects, sessions: sessions, manager: manager, bots: bots, weixin: wx, live: hub, logins: map[uuid.UUID]*weixinLogin{}}
}

// platformName names a channel type for people.
func platformName(t string) string {
	switch t {
	case channel.TypeLark:
		return "Lark"
	case channel.TypeWeixin:
		return "WeChat"
	}
	return "Feishu"
}

// The live "channels" frame: a project's channels changed, so its members
// reread them. A cleared conversation also names the channel.
type channelsEvent struct {
	ChannelID *uuid.UUID `json:"channel_id,omitempty"`
	Change    string     `json:"change,omitempty"`
}

// Changed tells a project's members its channels changed.
func (h *ChannelHandler) Changed(projectID uuid.UUID) {
	h.live.Publish(projectID, live.Event{Type: "channels"})
}

// channelView is a channel as the web sees it: never its secret or state.
type channelView struct {
	*model.Channel
	// Account is the account's id on its platform (a Feishu or Lark app id).
	Account string `json:"account"`
	// Bound: the channel knows its owner's platform id. Until then a Feishu
	// or Lark channel shows its creator the code to send the bot.
	Bound    bool   `json:"bound"`
	BindCode string `json:"bind_code,omitempty"`
}

func viewChannel(ch *model.Channel, viewer uuid.UUID) channelView {
	var cfg channel.Config
	_ = json.Unmarshal(ch.Config, &cfg)
	v := channelView{Channel: ch, Account: cfg.ExternalID, Bound: cfg.OwnerExternalID != ""}
	if !v.Bound && viewer == ch.CreatedByUserID {
		v.BindCode = cfg.BindCode
	}
	return v
}

func (h *ChannelHandler) requireEnabled() error {
	if !h.manager.Enabled() {
		return echo.NewHTTPError(http.StatusServiceUnavailable, "Channels are off: the server needs CHANNEL_SECRET_KEY")
	}
	return nil
}

// requireReadableChannel loads :channel_id for a member of its project.
func (h *ChannelHandler) requireReadableChannel(c echo.Context) (*model.Channel, *model.ProjectAccess, error) {
	userID, ok := UserIDFromContext(c)
	if !ok {
		return nil, nil, echo.ErrUnauthorized
	}
	notFound := echo.NewHTTPError(http.StatusNotFound, "channel not found")
	id, err := uuid.Parse(c.Param("channel_id"))
	if err != nil {
		return nil, nil, notFound
	}
	ch, err := h.channels.Get(c.Request().Context(), id)
	if err != nil {
		return nil, nil, notFound
	}
	access, err := h.projects.GetAccessible(c.Request().Context(), ch.ProjectID, userID)
	if err != nil {
		return nil, nil, notFound
	}
	return ch, access, nil
}

// requireOwnChannel additionally requires the caller to have created it.
func (h *ChannelHandler) requireOwnChannel(c echo.Context) (*model.Channel, error) {
	ch, _, err := h.requireReadableChannel(c)
	if err != nil {
		return nil, err
	}
	if userID, _ := UserIDFromContext(c); userID != ch.CreatedByUserID {
		return nil, echo.NewHTTPError(http.StatusForbidden, "only the channel's creator can use it")
	}
	return ch, nil
}

func conversationOf(ch *model.Channel) agentrun.Conversation {
	return agentrun.Conversation{ID: ch.ChannelID, ProjectID: ch.ProjectID, Kind: harness.KindChannel, Model: ch.Model, Effort: ch.Effort}
}

func (h *ChannelHandler) List(c echo.Context) error {
	access, err := requireReadableProject(c, h.projects)
	if err != nil {
		return err
	}
	channels, err := h.channels.ListByProject(c.Request().Context(), access.Project.ProjectID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	userID, _ := UserIDFromContext(c)
	views := make([]channelView, len(channels))
	for i, ch := range channels {
		views[i] = viewChannel(ch, userID)
	}
	return c.JSON(http.StatusOK, map[string]any{"enabled": h.manager.Enabled(), "channels": views})
}

func (h *ChannelHandler) Get(c echo.Context) error {
	ch, _, err := h.requireReadableChannel(c)
	if err != nil {
		return err
	}
	userID, _ := UserIDFromContext(c)
	return c.JSON(http.StatusOK, viewChannel(ch, userID))
}

func validName(name, fallback string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = fallback
	}
	if len([]rune(name)) > 100 {
		return "", echo.NewHTTPError(http.StatusBadRequest, "name must be at most 100 characters")
	}
	return name, nil
}

// modelFor validates a new channel's model and effort.
func (h *ChannelHandler) modelFor(modelID, effort string) (string, string, error) {
	id, err := resolveModel(h.sessions.models, modelID)
	if err != nil {
		return "", "", err
	}
	return id, agentrun.EffortFor(h.sessions.models, id, effort), nil
}

func (h *ChannelHandler) insert(c echo.Context, ch *model.Channel) error {
	if err := h.channels.Create(c.Request().Context(), ch); err != nil {
		var pqErr *pq.Error
		if errors.As(err, &pqErr) && pqErr.Code == "23505" {
			return echo.NewHTTPError(http.StatusConflict, "This account is already connected to a channel")
		}
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	h.manager.Reload(ch.ChannelID)
	h.Changed(ch.ProjectID)
	return nil
}

type createChannelRequest struct {
	Type      string `json:"type"`
	Name      string `json:"name"`
	Model     string `json:"model"`
	Effort    string `json:"effort"`
	AppID     string `json:"app_id"`
	AppSecret string `json:"app_secret"`
}

// Create adds a Feishu or Lark channel; WeChat channels come from a QR login.
func (h *ChannelHandler) Create(c echo.Context) error {
	if err := h.requireEnabled(); err != nil {
		return err
	}
	access, err := requireWritableProject(c, h.projects)
	if err != nil {
		return err
	}
	userID, _ := UserIDFromContext(c)
	var req createChannelRequest
	if err := c.Bind(&req); err != nil {
		return echo.ErrBadRequest
	}
	bot := h.bots[req.Type]
	if bot == nil {
		return echo.NewHTTPError(http.StatusBadRequest, "type must be feishu or lark; WeChat channels are added by scanning a QR code")
	}
	req.AppID, req.AppSecret = strings.TrimSpace(req.AppID), strings.TrimSpace(req.AppSecret)
	if req.AppID == "" || req.AppSecret == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "app_id and app_secret are required")
	}
	ctx, cancel := context.WithTimeout(c.Request().Context(), 15*time.Second)
	defer cancel()
	botName, err := bot.Validate(ctx, req.AppID, req.AppSecret)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, platformName(req.Type)+": "+err.Error())
	}
	name, err := validName(req.Name, botName)
	if err != nil {
		return err
	}
	if name == "" {
		name = platformName(req.Type)
	}
	modelID, effort, err := h.modelFor(req.Model, req.Effort)
	if err != nil {
		return err
	}
	cfg, _ := json.Marshal(channel.Config{
		ExternalID: req.AppID, Secret: h.manager.Seal(req.AppSecret), BindCode: bindCode(),
	})
	ch := &model.Channel{
		ChannelID: uuid.New(), ProjectID: access.Project.ProjectID, Type: req.Type, Name: name,
		Model: modelID, Effort: effort, Config: cfg, Enabled: true, Status: channel.StatusConnecting, CreatedByUserID: userID,
	}
	if err := h.insert(c, ch); err != nil {
		return err
	}
	return c.JSON(http.StatusCreated, viewChannel(ch, userID))
}

// bindCode is the six digits a Feishu or Lark channel's owner sends its bot.
func bindCode() string {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		panic(err)
	}
	return fmt.Sprintf("%06d", n.Int64())
}

type updateChannelRequest struct {
	Name      *string `json:"name"`
	Model     *string `json:"model"`
	Effort    *string `json:"effort"`
	Enabled   *bool   `json:"enabled"`
	AppSecret *string `json:"app_secret"`
}

func (h *ChannelHandler) Update(c echo.Context) error {
	ch, err := h.requireOwnChannel(c)
	if err != nil {
		return err
	}
	var req updateChannelRequest
	if err := c.Bind(&req); err != nil {
		return echo.ErrBadRequest
	}
	ctx := c.Request().Context()
	name, modelID, effort, enabled := ch.Name, ch.Model, ch.Effort, ch.Enabled
	if req.Name != nil {
		if name, err = validName(*req.Name, ""); err != nil {
			return err
		}
		if name == "" {
			return echo.NewHTTPError(http.StatusBadRequest, "name must not be empty")
		}
	}
	if req.Model != nil || req.Effort != nil {
		if req.Model != nil {
			if strings.TrimSpace(*req.Model) == "" {
				return echo.NewHTTPError(http.StatusBadRequest, "model must not be empty")
			}
			if modelID, err = resolveModel(h.sessions.models, *req.Model); err != nil {
				return err
			}
		} else if _, ok := h.sessions.models.Get(modelID); !ok {
			return echo.NewHTTPError(http.StatusBadRequest, fmt.Sprintf("model %q is no longer configured; switch to another model", modelID))
		}
		effort = agentrun.EffortFor(h.sessions.models, modelID, effort)
		if req.Effort != nil {
			m, _ := h.sessions.models.Get(modelID)
			if !m.Provider.HasEffort(*req.Effort) {
				return echo.NewHTTPError(http.StatusBadRequest, fmt.Sprintf("effort %q is not offered for model %q", *req.Effort, modelID))
			}
			effort = *req.Effort
		}
	}
	reload := false
	if req.Enabled != nil && *req.Enabled != enabled {
		enabled, reload = *req.Enabled, true
	}
	if req.AppSecret != nil {
		if err := h.requireEnabled(); err != nil {
			return err
		}
		bot := h.bots[ch.Type]
		if bot == nil {
			return echo.NewHTTPError(http.StatusBadRequest, "only Feishu and Lark channels have an app secret; scan again to renew a WeChat login")
		}
		secret := strings.TrimSpace(*req.AppSecret)
		var cfg channel.Config
		_ = json.Unmarshal(ch.Config, &cfg)
		vctx, cancel := context.WithTimeout(ctx, 15*time.Second)
		_, verr := bot.Validate(vctx, cfg.ExternalID, secret)
		cancel()
		if verr != nil {
			return echo.NewHTTPError(http.StatusBadRequest, platformName(ch.Type)+": "+verr.Error())
		}
		if err := h.channels.MergeConfig(ctx, ch.ChannelID, map[string]any{"secret": h.manager.Seal(secret)}); err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
		}
		reload = true
	}
	if err := h.channels.Update(ctx, ch.ChannelID, name, modelID, effort, enabled); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	if reload {
		h.manager.Reload(ch.ChannelID)
	}
	ch, err = h.channels.Get(ctx, ch.ChannelID)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "channel not found")
	}
	h.Changed(ch.ProjectID)
	userID, _ := UserIDFromContext(c)
	return c.JSON(http.StatusOK, viewChannel(ch, userID))
}

// dropConversation deletes the channel's transcript, collecting its usage
// first while the channel still names who it belongs to.
func (h *ChannelHandler) dropConversation(ctx context.Context, ch *model.Channel, start bool) error {
	sandboxURL, ok := h.sessions.sandbox.URL(ctx, ch.ProjectID)
	if !ok && start {
		var err error
		if sandboxURL, err = h.sessions.sandbox.Await(ctx, ch.ProjectID); err != nil {
			return echo.NewHTTPError(http.StatusServiceUnavailable, "sandbox unavailable: "+err.Error())
		}
		ok = true
	}
	if !ok {
		return nil
	}
	if h.sessions.usage != nil {
		syncCtx, cancel := context.WithTimeout(ctx, usage.Inline)
		h.sessions.usage.Sync(syncCtx, ch.ProjectID)
		cancel()
	}
	return h.sessions.harnessClient.DeleteSession(ctx, sandboxURL, ch.ChannelID.String())
}

// Delete removes the channel and its conversation. Its creator or the
// project owner may.
func (h *ChannelHandler) Delete(c echo.Context) error {
	ch, access, err := h.requireReadableChannel(c)
	if err != nil {
		return err
	}
	if userID, _ := UserIDFromContext(c); userID != ch.CreatedByUserID && access.AccessRole != model.AccessOwner {
		return echo.NewHTTPError(http.StatusForbidden, "only the channel's creator or the project owner can delete it")
	}
	h.manager.Stop(ch.ChannelID)
	if err := h.dropConversation(c.Request().Context(), ch, false); err != nil {
		log.Printf("warn: delete channel conversation %s: %v", ch.ChannelID, err)
	}
	if err := h.channels.Delete(c.Request().Context(), ch.ChannelID); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	h.Changed(ch.ProjectID)
	return c.NoContent(http.StatusNoContent)
}

// Clear deletes the conversation; the next message starts a new one.
func (h *ChannelHandler) Clear(c echo.Context) error {
	ch, err := h.requireOwnChannel(c)
	if err != nil {
		return err
	}
	if err := h.dropConversation(c.Request().Context(), ch, true); err != nil {
		var he *echo.HTTPError
		if errors.As(err, &he) {
			return he
		}
		return echo.NewHTTPError(http.StatusBadGateway, err.Error())
	}
	h.live.Publish(ch.ProjectID, live.Event{Type: "channels", Data: channelsEvent{ChannelID: &ch.ChannelID, Change: "cleared"}})
	return c.NoContent(http.StatusNoContent)
}

// ── The conversation, as the channel tab sees it ─────────────────────────────

func (h *ChannelHandler) History(c echo.Context) error {
	ch, _, err := h.requireReadableChannel(c)
	if err != nil {
		return err
	}
	ctx := c.Request().Context()
	sandboxURL, err := h.sessions.sandbox.Await(ctx, ch.ProjectID)
	if err != nil {
		return echo.NewHTTPError(http.StatusServiceUnavailable, "sandbox unavailable: "+err.Error())
	}
	items, err := h.sessions.harnessClient.History(ctx, sandboxURL, ch.ChannelID.String())
	if err != nil {
		return echo.NewHTTPError(http.StatusBadGateway, err.Error())
	}
	if items == nil {
		items = []harness.PlatformHistoryItem{}
	}
	return c.JSON(http.StatusOK, items)
}

func sseStart(c echo.Context) {
	c.Response().Header().Set("Content-Type", "text/event-stream")
	c.Response().Header().Set("Cache-Control", "no-cache")
	c.Response().Header().Set("Connection", "keep-alive")
	c.Response().Header().Set("X-Accel-Buffering", "no")
	c.Response().WriteHeader(http.StatusOK)
	c.Response().Flush()
}

func (h *ChannelHandler) Events(c echo.Context) error {
	ch, _, err := h.requireReadableChannel(c)
	if err != nil {
		return err
	}
	ctx := c.Request().Context()
	sandboxURL, err := h.sessions.sandbox.Await(ctx, ch.ProjectID)
	if err != nil {
		return echo.NewHTTPError(http.StatusServiceUnavailable, "sandbox unavailable: "+err.Error())
	}
	onEvent := func(ev *harness.PlatformEvent) bool { return ev.Type != harness.EventSessionTitle }
	err = h.sessions.harnessClient.StreamEvents(ctx, sandboxURL, ch.ChannelID.String(), c.Response(), onEvent, func() error {
		sseStart(c)
		return nil
	})
	if c.Response().Committed {
		return nil
	}
	if err != nil {
		return echo.NewHTTPError(http.StatusBadGateway, err.Error())
	}
	return nil
}

// SendMessage prompts the channel's conversation from the web. The reply
// streams back here only; the chat sees the turns it starts itself.
func (h *ChannelHandler) SendMessage(c echo.Context) error {
	ch, err := h.requireOwnChannel(c)
	if err != nil {
		return err
	}
	var req struct {
		Text string `json:"text"`
	}
	if err := c.Bind(&req); err != nil || req.Text == "" {
		return echo.ErrBadRequest
	}
	ctx := c.Request().Context()
	sandboxURL, err := h.sessions.sandbox.Await(ctx, ch.ProjectID)
	if err != nil {
		return echo.NewHTTPError(http.StatusServiceUnavailable, "sandbox unavailable: "+err.Error())
	}
	if err := agentrun.Register(ctx, h.sessions.harnessClient, h.sessions.models, sandboxURL, conversationOf(ch)); err != nil {
		var he *echo.HTTPError
		if errors.As(registerError(err), &he) {
			return he
		}
		return echo.NewHTTPError(http.StatusBadGateway, err.Error())
	}
	id := ch.ChannelID.String()
	onEvent := func(ev *harness.PlatformEvent) bool { return ev.Type != harness.EventSessionTitle }
	err = h.sessions.harnessClient.StreamEventsUntilIdle(ctx, sandboxURL, id, c.Response(), onEvent, func() error {
		if err := h.sessions.harnessClient.PromptAsync(ctx, sandboxURL, id, req.Text); err != nil {
			if errors.Is(err, harness.ErrSteered) {
				return err
			}
			return echo.NewHTTPError(http.StatusBadGateway, err.Error())
		}
		sseStart(c)
		return nil
	})
	if errors.Is(err, harness.ErrSteered) {
		return c.NoContent(http.StatusAccepted)
	}
	h.sessions.syncUsage(ch.ProjectID)
	return err
}

func (h *ChannelHandler) Abort(c echo.Context) error {
	ch, err := h.requireOwnChannel(c)
	if err != nil {
		return err
	}
	sandboxURL, ok := h.sessions.sandbox.URL(c.Request().Context(), ch.ProjectID)
	if !ok {
		return c.NoContent(http.StatusNoContent)
	}
	if err := h.sessions.harnessClient.Abort(c.Request().Context(), sandboxURL, ch.ChannelID.String()); err != nil {
		return echo.NewHTTPError(http.StatusBadGateway, err.Error())
	}
	return c.NoContent(http.StatusNoContent)
}

func (h *ChannelHandler) WithdrawQueued(c echo.Context) error {
	ch, err := h.requireOwnChannel(c)
	if err != nil {
		return err
	}
	index, err := strconv.Atoi(c.Param("index"))
	if err != nil || index < 0 {
		return echo.ErrBadRequest
	}
	var req struct {
		Text string `json:"text"`
	}
	if err := c.Bind(&req); err != nil {
		return echo.ErrBadRequest
	}
	gone := echo.NewHTTPError(http.StatusConflict, "This message has already been sent")
	base, ok := h.sessions.sandbox.URL(c.Request().Context(), ch.ProjectID)
	if !ok {
		return gone
	}
	messages, ok, err := h.sessions.harnessClient.WithdrawQueued(c.Request().Context(), base, ch.ChannelID.String(), index, req.Text)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadGateway, err.Error())
	}
	if !ok {
		return gone
	}
	if messages == nil {
		messages = []string{}
	}
	return c.JSON(http.StatusOK, map[string]any{"messages": messages})
}

func (h *ChannelHandler) AnswerQuestionnaire(c echo.Context) error {
	ch, err := h.requireOwnChannel(c)
	if err != nil {
		return err
	}
	var body json.RawMessage
	if err := json.NewDecoder(http.MaxBytesReader(c.Response(), c.Request().Body, 1024*1024)).Decode(&body); err != nil {
		return echo.ErrBadRequest
	}
	base, ok := h.sessions.sandbox.URL(c.Request().Context(), ch.ProjectID)
	if !ok {
		return echo.NewHTTPError(http.StatusConflict, "This conversation is no longer waiting for answers")
	}
	status, message, err := h.sessions.harnessClient.AnswerQuestionnaire(c.Request().Context(), base, ch.ChannelID.String(), c.Param("tool_id"), body)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadGateway, err.Error())
	}
	if status != http.StatusNoContent {
		if status != http.StatusBadRequest && status != http.StatusConflict {
			status = http.StatusBadGateway
		}
		if message == "" {
			message = "Unable to submit questionnaire"
		}
		return echo.NewHTTPError(status, message)
	}
	return c.NoContent(http.StatusNoContent)
}

// Fork copies the conversation into a new session owned by the caller: the
// way to carry a channel's conversation on in the web.
func (h *ChannelHandler) Fork(c echo.Context) error {
	userID, ok := UserIDFromContext(c)
	if !ok {
		return echo.ErrUnauthorized
	}
	ch, _, err := h.requireReadableChannel(c)
	if err != nil {
		return err
	}
	var req forkSessionRequest
	if err := c.Bind(&req); err != nil {
		return echo.ErrBadRequest
	}
	ctx := c.Request().Context()
	sandboxURL, err := h.sessions.sandbox.Await(ctx, ch.ProjectID)
	if err != nil {
		return echo.NewHTTPError(http.StatusServiceUnavailable, "sandbox unavailable: "+err.Error())
	}
	title := ch.Name + " (fork)"
	sess := &model.Session{
		SessionID: uuid.New(), ProjectID: ch.ProjectID, Model: ch.Model, Effort: ch.Effort, Status: "ready", Title: &title,
	}
	if err := h.sessions.harnessClient.ForkSession(ctx, sandboxURL, ch.ChannelID.String(), sess.SessionID.String(), req.Before); err != nil {
		switch {
		case errors.Is(err, harness.ErrForkPoint):
			return echo.NewHTTPError(http.StatusNotFound, err.Error())
		case errors.Is(err, harness.ErrForkBusy):
			return echo.NewHTTPError(http.StatusConflict, err.Error())
		}
		return echo.NewHTTPError(http.StatusBadGateway, err.Error())
	}
	if err := h.sessions.sessionStore.Create(ctx, sess, userID); err != nil {
		if err := h.sessions.harnessClient.DeleteSession(context.Background(), sandboxURL, sess.SessionID.String()); err != nil {
			log.Printf("warn: delete orphaned fork %s: %v", sess.SessionID, err)
		}
		if errors.Is(err, sql.ErrNoRows) {
			return echo.ErrUnauthorized
		}
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	if err := h.sessions.ensureAgentSession(ctx, sandboxURL, sess); err != nil {
		log.Printf("warn: register fork %s: %v", sess.SessionID, err)
	}
	h.sessions.publish(sess.ProjectID, sessionEvent{SessionID: sess.SessionID, Change: sessionForked, Status: sess.Status})
	return c.JSON(http.StatusCreated, sess)
}

// ── WeChat QR logins ─────────────────────────────────────────────────────────

// weixinLogin is a QR login in progress: for a new channel, or to renew an
// existing channel's login. Logins live in memory, which suits the single
// replica; a restart only means scanning a fresh code.
type weixinLogin struct {
	mu        sync.Mutex
	login     *weixin.Login
	projectID uuid.UUID
	userID    uuid.UUID
	channelID *uuid.UUID
	name      string
	model     string
	effort    string
	expires   time.Time
	status    string
	err       string
	channel   *model.Channel
}

type weixinLoginView struct {
	LoginID   uuid.UUID    `json:"login_id"`
	QR        string       `json:"qr,omitempty"`
	ExpiresAt time.Time    `json:"expires_at"`
	Status    string       `json:"status"`
	Error     string       `json:"error,omitempty"`
	Channel   *channelView `json:"channel,omitempty"`
}

func (h *ChannelHandler) pruneLogins() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for id, l := range h.logins {
		if time.Now().After(l.expires.Add(time.Minute)) {
			delete(h.logins, id)
		}
	}
}

func qrDataURL(content string) (string, error) {
	png, err := qrcode.Encode(content, qrcode.Medium, 320)
	if err != nil {
		return "", err
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(png), nil
}

type startWeixinLoginRequest struct {
	// ChannelID renews that channel's login; empty creates a channel.
	ChannelID *uuid.UUID `json:"channel_id"`
	Name      string     `json:"name"`
	Model     string     `json:"model"`
	Effort    string     `json:"effort"`
}

func (h *ChannelHandler) StartWeixinLogin(c echo.Context) error {
	if err := h.requireEnabled(); err != nil {
		return err
	}
	access, err := requireWritableProject(c, h.projects)
	if err != nil {
		return err
	}
	userID, _ := UserIDFromContext(c)
	var req startWeixinLoginRequest
	if err := c.Bind(&req); err != nil {
		return echo.ErrBadRequest
	}
	l := &weixinLogin{projectID: access.Project.ProjectID, userID: userID, status: weixin.LoginWaiting}
	if req.ChannelID != nil {
		ch, err := h.channels.Get(c.Request().Context(), *req.ChannelID)
		if err != nil || ch.ProjectID != l.projectID || ch.Type != channel.TypeWeixin {
			return echo.NewHTTPError(http.StatusNotFound, "channel not found")
		}
		if ch.CreatedByUserID != userID {
			return echo.NewHTTPError(http.StatusForbidden, "only the channel's creator can use it")
		}
		l.channelID = &ch.ChannelID
	} else {
		if l.name, err = validName(req.Name, "WeChat"); err != nil {
			return err
		}
		if l.model, l.effort, err = h.modelFor(req.Model, req.Effort); err != nil {
			return err
		}
	}
	ctx, cancel := context.WithTimeout(c.Request().Context(), 15*time.Second)
	defer cancel()
	if l.login, err = h.weixin.StartLogin(ctx, nil); err != nil {
		return echo.NewHTTPError(http.StatusBadGateway, err.Error())
	}
	qr, err := qrDataURL(l.login.QR)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	l.expires = time.Now().Add(weixin.LoginTTL())
	id := uuid.New()
	h.pruneLogins()
	h.mu.Lock()
	h.logins[id] = l
	h.mu.Unlock()
	return c.JSON(http.StatusOK, weixinLoginView{LoginID: id, QR: qr, ExpiresAt: l.expires, Status: l.status})
}

func (h *ChannelHandler) loginFor(c echo.Context) (uuid.UUID, *weixinLogin, error) {
	userID, _ := UserIDFromContext(c)
	id, err := uuid.Parse(c.Param("login_id"))
	if err != nil {
		return id, nil, echo.NewHTTPError(http.StatusNotFound, "login not found")
	}
	h.mu.Lock()
	l := h.logins[id]
	h.mu.Unlock()
	if l == nil || l.userID != userID || c.Param("project_id") != l.projectID.String() {
		return id, nil, echo.NewHTTPError(http.StatusNotFound, "login not found")
	}
	return id, l, nil
}

// PollWeixinLogin waits for the login to move on (WeChat holds the request
// up to about half a minute) and reports where it is. Once confirmed, the
// channel exists (or has its login renewed) and is connecting.
func (h *ChannelHandler) PollWeixinLogin(c echo.Context) error {
	id, l, err := h.loginFor(c)
	if err != nil {
		return err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	view := func() error {
		v := weixinLoginView{LoginID: id, ExpiresAt: l.expires, Status: l.status, Error: l.err}
		if l.channel != nil {
			cv := viewChannel(l.channel, l.userID)
			v.Channel = &cv
		}
		return c.JSON(http.StatusOK, v)
	}
	if l.status == weixin.LoginConfirmed || l.err != "" {
		return view()
	}
	if time.Now().After(l.expires) {
		l.status = weixin.LoginExpired
		return view()
	}
	ctx, cancel := context.WithTimeout(c.Request().Context(), 40*time.Second)
	defer cancel()
	status, result, err := l.login.Poll(ctx)
	switch {
	case errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled):
		return view()
	case err != nil:
		l.err = err.Error()
		return view()
	}
	l.status = status
	if result != nil {
		if err := h.finishWeixinLogin(c.Request().Context(), l, result); err != nil {
			var he *echo.HTTPError
			if errors.As(err, &he) {
				l.err = fmt.Sprint(he.Message)
			} else {
				l.err = err.Error()
			}
		}
	}
	return view()
}

func (h *ChannelHandler) finishWeixinLogin(ctx context.Context, l *weixinLogin, r *weixin.LoginResult) error {
	keys := map[string]any{
		"external_id": r.BotID, "secret": h.manager.Seal(r.Token), "owner_external_id": r.UserID,
		"base_url": r.BaseURL, "state": map[string]any{},
	}
	if l.channelID != nil {
		if err := h.channels.MergeConfig(ctx, *l.channelID, keys); err != nil {
			var pqErr *pq.Error
			if errors.As(err, &pqErr) && pqErr.Code == "23505" {
				return echo.NewHTTPError(http.StatusConflict, "This WeChat is already connected to another channel")
			}
			return err
		}
		if _, err := h.channels.SetStatus(ctx, *l.channelID, channel.StatusConnecting, nil); err != nil {
			return err
		}
		h.manager.Reload(*l.channelID)
		ch, err := h.channels.Get(ctx, *l.channelID)
		if err != nil {
			return err
		}
		l.channel = ch
		h.Changed(ch.ProjectID)
		return nil
	}
	cfg, _ := json.Marshal(keys)
	ch := &model.Channel{
		ChannelID: uuid.New(), ProjectID: l.projectID, Type: channel.TypeWeixin, Name: l.name,
		Model: l.model, Effort: l.effort, Config: cfg, Enabled: true, Status: channel.StatusConnecting, CreatedByUserID: l.userID,
	}
	if err := h.channels.Create(ctx, ch); err != nil {
		var pqErr *pq.Error
		if errors.As(err, &pqErr) && pqErr.Code == "23505" {
			return echo.NewHTTPError(http.StatusConflict, "This WeChat is already connected to a channel")
		}
		return err
	}
	h.manager.Reload(ch.ChannelID)
	h.Changed(ch.ProjectID)
	l.channel = ch
	return nil
}

// VerifyWeixinLogin passes on the code WeChat shows on the phone.
func (h *ChannelHandler) VerifyWeixinLogin(c echo.Context) error {
	_, l, err := h.loginFor(c)
	if err != nil {
		return err
	}
	var req struct {
		Code string `json:"code"`
	}
	if err := c.Bind(&req); err != nil || strings.TrimSpace(req.Code) == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "code is required")
	}
	// Not under l.mu: a poll may be waiting; the next one sends the code.
	l.login.Verify(req.Code)
	return c.NoContent(http.StatusNoContent)
}
