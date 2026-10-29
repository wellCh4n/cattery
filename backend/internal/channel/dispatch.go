package channel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/wellch4n/cattery/internal/agentrun"
	"github.com/wellch4n/cattery/internal/harness"
)

var errNotMember = errors.New("this channel's creator is no longer a member of its project")

const helpText = "Messages you send here go to this channel's agent in Cattery.\n" +
	"/stop stops the reply in progress.\n" +
	"While the agent asks a question, reply with an option's number or your own answer; /cancel skips it."

// dispatcher takes one connected channel's inbound messages: it drops
// redeliveries and anyone but the owner, runs commands, answers a pending
// questionnaire, and otherwise prompts the channel's conversation.
type dispatcher struct {
	m    *Manager
	id   uuid.UUID
	ctx  context.Context
	conn Conn
	caps Capabilities

	seen *recent

	mu       sync.Mutex
	owner    string
	bindCode string
	asking   *asking
	// start serializes starting runs, so two quick messages start one run and
	// steer the other into it.
	start sync.Mutex
}

// asking is a questionnaire collecting its answers one question at a time.
type asking struct {
	toolID    string
	questions []question
	answers   []map[string]any
}

func (d *dispatcher) inbound(in Inbound) {
	if in.MessageID != "" && !d.seen.add(in.MessageID) {
		return
	}
	go d.handle(in)
}

func (d *dispatcher) handle(in Inbound) {
	text := strings.TrimSpace(in.Text)
	if text == "" {
		return
	}
	d.mu.Lock()
	owner, code := d.owner, d.bindCode
	d.mu.Unlock()
	if owner == "" {
		// Unbound (Feishu, Lark): only the bind code from the channel's dialog binds.
		if code != "" && text == "/bind "+code {
			d.bind(in)
		}
		return
	}
	if in.SenderID != owner {
		log.Printf("channel %s: ignoring a message from %s, who is not its owner", d.id, in.SenderID)
		return
	}
	switch strings.ToLower(text) {
	case "/help":
		d.reply(in.To, helpText)
		return
	case "/stop":
		conv, err := d.conversation()
		if err == nil {
			err = d.m.runner.Abort(d.ctx, conv)
		}
		if err != nil {
			d.reply(in.To, "⚠️ "+err.Error())
		}
		return
	}
	if d.answer(in.To, text) {
		return
	}
	d.run(in.To, text)
}

func (d *dispatcher) bind(in Inbound) {
	ctx, cancel := context.WithTimeout(d.ctx, 5*time.Second)
	defer cancel()
	if err := d.m.store.MergeConfig(ctx, d.id, map[string]any{"owner_external_id": in.SenderID, "bind_code": ""}); err != nil {
		log.Printf("channel %s: bind: %v", d.id, err)
		return
	}
	d.mu.Lock()
	d.owner, d.bindCode = in.SenderID, ""
	d.mu.Unlock()
	d.m.changed(d.id)
	d.reply(in.To, "✅ Connected. Messages you send here now go to this channel's agent in Cattery.")
}

func (d *dispatcher) conversation() (agentrun.Conversation, error) {
	ctx, cancel := context.WithTimeout(d.ctx, 5*time.Second)
	defer cancel()
	ch, err := d.m.store.Get(ctx, d.id)
	if err != nil {
		return agentrun.Conversation{}, err
	}
	if d.m.member != nil && !d.m.member(ctx, ch.ProjectID, ch.CreatedByUserID) {
		return agentrun.Conversation{}, errNotMember
	}
	return agentrun.Conversation{ID: ch.ChannelID, ProjectID: ch.ProjectID, Kind: harness.KindChannel, Model: ch.Model, Effort: ch.Effort}, nil
}

// run prompts the conversation, rendering the run it starts. A message sent
// while it runs is steered into that run, whose renderer shows the answer.
func (d *dispatcher) run(to Target, text string) {
	conv, err := d.conversation()
	if errors.Is(err, errNotMember) {
		d.reply(to, "⚠️ "+err.Error()+".")
		return
	}
	if err != nil {
		log.Printf("channel %s: load: %v", d.id, err)
		return
	}
	d.start.Lock()
	r := newRenderer(d.ctx, d.conn, d.caps, to, func(toolID string, qs []question) { d.ask(to, toolID, qs) }, d.answered)
	var once sync.Once
	release := func() { once.Do(d.start.Unlock) }
	err = d.m.runner.Run(d.ctx, conv, text, release, r.event)
	release()
	r.finish()
	d.m.syncUsage(conv.ProjectID)
	switch {
	case err == nil, errors.Is(err, harness.ErrSteered), d.ctx.Err() != nil:
	default:
		var gone *agentrun.ModelGoneError
		if errors.As(err, &gone) {
			d.reply(to, "⚠️ "+gone.Error()+" in this channel's settings in Cattery.")
			return
		}
		log.Printf("channel %s: run: %v", d.id, err)
		d.reply(to, "⚠️ "+err.Error())
	}
}

// ask starts collecting a questionnaire's answers.
func (d *dispatcher) ask(to Target, toolID string, qs []question) {
	d.mu.Lock()
	d.asking = &asking{toolID: toolID, questions: qs}
	d.mu.Unlock()
	d.reply(to, renderQuestion(qs, 0))
}

func (d *dispatcher) answered(toolID string) {
	d.mu.Lock()
	if d.asking != nil && d.asking.toolID == toolID {
		d.asking = nil
	}
	d.mu.Unlock()
}

// answer takes text as the answer to the pending question, if there is one.
func (d *dispatcher) answer(to Target, text string) bool {
	d.mu.Lock()
	a := d.asking
	if a == nil {
		d.mu.Unlock()
		return false
	}
	var body map[string]any
	if strings.EqualFold(text, "/cancel") {
		d.asking = nil
		body = map[string]any{"cancelled": true}
	} else {
		q := a.questions[len(a.answers)]
		ans, ok := parseAnswer(&q, text)
		if !ok {
			d.mu.Unlock()
			d.reply(to, fmt.Sprintf("Reply with a number from 1 to %d.", len(q.Options)))
			return true
		}
		a.answers = append(a.answers, ans)
		if len(a.answers) < len(a.questions) {
			next := renderQuestion(a.questions, len(a.answers))
			d.mu.Unlock()
			d.reply(to, next)
			return true
		}
		d.asking = nil
		body = map[string]any{"answers": a.answers}
	}
	d.mu.Unlock()
	b, _ := json.Marshal(body)
	conv, err := d.conversation()
	if err == nil {
		err = d.m.runner.Answer(d.ctx, conv, a.toolID, b)
	}
	if err != nil {
		d.reply(to, "⚠️ "+err.Error())
	}
	return true
}

func parseAnswer(q *question, text string) (map[string]any, bool) {
	if n, err := strconv.Atoi(text); err == nil && n >= 1 && n <= len(q.Options) {
		return map[string]any{"id": q.ID, "value": q.Options[n-1].Value, "wasCustom": false}, true
	}
	for _, o := range q.Options {
		if strings.EqualFold(text, o.Label) || strings.EqualFold(text, o.Value) {
			return map[string]any{"id": q.ID, "value": o.Value, "wasCustom": false}, true
		}
	}
	if q.allowOther() {
		return map[string]any{"id": q.ID, "value": text, "wasCustom": true}, true
	}
	return nil, false
}

func renderQuestion(qs []question, i int) string {
	q := qs[i]
	var b strings.Builder
	b.WriteString("❓ ")
	if len(qs) > 1 {
		fmt.Fprintf(&b, "(%d/%d) ", i+1, len(qs))
	}
	b.WriteString(q.Prompt)
	for n, o := range q.Options {
		fmt.Fprintf(&b, "\n%d. %s", n+1, o.Label)
		if o.Description != "" {
			b.WriteString(" — " + o.Description)
		}
	}
	switch {
	case len(q.Options) > 0 && q.allowOther():
		b.WriteString("\n\nReply with a number, or type your own answer.")
	case len(q.Options) > 0:
		b.WriteString("\n\nReply with a number.")
	}
	return b.String()
}

func (d *dispatcher) reply(to Target, text string) {
	if !d.caps.Markdown {
		text = plainText(text)
	}
	for _, part := range splitText(text, d.caps.TextLimit) {
		if _, err := d.conn.Send(d.ctx, to, part); err != nil {
			log.Printf("channel %s: send: %v", d.id, err)
			return
		}
	}
}

// recent remembers the last message ids seen, to drop redeliveries.
type recent struct {
	mu   sync.Mutex
	ids  map[string]struct{}
	ring []string
	next int
}

func newRecent(n int) *recent { return &recent{ids: map[string]struct{}{}, ring: make([]string, n)} }

// add reports whether id is new.
func (r *recent) add(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.ids[id]; ok {
		return false
	}
	if old := r.ring[r.next]; old != "" {
		delete(r.ids, old)
	}
	r.ring[r.next] = id
	r.ids[id] = struct{}{}
	r.next = (r.next + 1) % len(r.ring)
	return true
}
