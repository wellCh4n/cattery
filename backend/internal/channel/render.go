package channel

import (
	"context"
	"encoding/json"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/wellch4n/cattery/internal/harness"
)

// How replies reach the chat. With EditMessage a reply is one message edited
// at most once per editEvery while it streams (a new one once it outgrows the
// platform's limit). Otherwise finished text goes out in blocks: text ends at a
// tool call, a delivered steered message or the run's end, and a block waits
// for more text until it holds blockMin bytes or blockIdle passes.
const (
	editEvery  = time.Second
	blockMin   = 400
	blockIdle  = 2 * time.Second
	tick       = 250 * time.Millisecond
	typingKeep = 8 * time.Second
	// A questionnaire's arguments stream in repeated tool.start events; it is
	// asked once they stop changing.
	questionSettle = 800 * time.Millisecond
)

type question struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Prompt   string `json:"prompt"`
	Options  []questionOption
	AllowOth *bool `json:"allowOther"`
}

type questionOption struct {
	Value       string `json:"value"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

func (q *question) UnmarshalJSON(b []byte) error {
	type plain struct {
		ID       string           `json:"id"`
		Label    string           `json:"label"`
		Prompt   string           `json:"prompt"`
		Options  []questionOption `json:"options"`
		AllowOth *bool            `json:"allowOther"`
	}
	var p plain
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	*q = question{p.ID, p.Label, p.Prompt, p.Options, p.AllowOth}
	return nil
}

func (q *question) allowOther() bool { return q.AllowOth == nil || *q.AllowOth }

// renderer turns one run's platform events into chat messages.
type renderer struct {
	ctx  context.Context
	conn Conn
	caps Capabilities
	to   Target
	// asked hands a questionnaire to the dispatcher, which collects answers;
	// answered tells it the tool finished.
	asked    func(toolID string, qs []question)
	answered func(toolID string)

	mu sync.Mutex
	// Preview: the reply's text so far, and the messages showing it (more
	// than one once it outgrew the limit) with what each shows.
	parts    []string
	partIdx  map[string]int
	tools    map[string]bool
	msgIDs   []string
	shown    []string
	lastEdit time.Time
	// Blocks: text not sent yet, and whether it ended (and when).
	pending string
	part    string
	ended   bool
	endedAt time.Time
	// Questionnaires waiting for their arguments to settle, by tool id.
	questions map[string]*time.Timer

	stop chan struct{}
	done chan struct{}
}

func newRenderer(ctx context.Context, conn Conn, caps Capabilities, to Target, asked func(string, []question), answered func(string)) *renderer {
	r := &renderer{
		ctx: ctx, conn: conn, caps: caps, to: to, asked: asked, answered: answered,
		partIdx: map[string]int{}, tools: map[string]bool{}, questions: map[string]*time.Timer{},
		stop: make(chan struct{}), done: make(chan struct{}),
	}
	go r.loop()
	return r
}

func (r *renderer) loop() {
	defer close(r.done)
	t := time.NewTicker(tick)
	defer t.Stop()
	var typedAt time.Time
	for {
		if !r.caps.EditMessage && time.Since(typedAt) >= typingKeep {
			typedAt = time.Now()
			_ = r.conn.Typing(r.ctx, r.to, true)
		}
		select {
		case <-r.stop:
			return
		case <-r.ctx.Done():
			return
		case <-t.C:
			r.mu.Lock()
			r.flushLocked(false)
			r.mu.Unlock()
		}
	}
}

// event takes one platform event of the run.
func (r *renderer) event(ev *harness.PlatformEvent) {
	r.mu.Lock()
	defer r.mu.Unlock()
	switch ev.Type {
	case harness.EventMessageDelta:
		var d harness.MessageDeltaData
		if json.Unmarshal(ev.Data, &d) != nil || d.Text == "" {
			return
		}
		r.text(d.PartID, d.Text)
	case harness.EventMessageUser:
		// A steered message reached the model: what follows answers it.
		r.endText()
		if r.caps.EditMessage {
			r.flushLocked(true)
			r.parts, r.partIdx, r.tools, r.msgIDs, r.shown = nil, map[string]int{}, map[string]bool{}, nil, nil
		}
	case harness.EventToolStart:
		var d harness.ToolStartData
		if json.Unmarshal(ev.Data, &d) != nil {
			return
		}
		r.endText()
		if d.Tool == "questionnaire" {
			r.questionnaire(d.ToolID, d.Input)
			return
		}
		if r.caps.EditMessage && !r.tools[d.ToolID] {
			r.tools[d.ToolID] = true
			r.parts = append(r.parts, "`⚙ "+d.Tool+"`")
		}
	case harness.EventToolDone:
		var d harness.ToolDoneData
		if json.Unmarshal(ev.Data, &d) != nil {
			return
		}
		if d.Tool == "questionnaire" {
			if t := r.questions[d.ToolID]; t != nil {
				t.Stop()
				delete(r.questions, d.ToolID)
			}
			r.answered(d.ToolID)
		}
	case harness.EventSessionError:
		var d harness.SessionErrorData
		if json.Unmarshal(ev.Data, &d) != nil || d.Message == "" {
			return
		}
		r.endText()
		r.flushLocked(true)
		r.sendLocked("⚠️ " + d.Message)
	}
}

func (r *renderer) text(partID, text string) {
	if r.caps.EditMessage {
		i, ok := r.partIdx[partID]
		if !ok {
			i = len(r.parts)
			r.partIdx[partID] = i
			r.parts = append(r.parts, "")
		}
		r.parts[i] += text
		return
	}
	if partID != r.part {
		r.endText()
		r.part = partID
		if r.pending != "" {
			r.pending += "\n\n"
		}
	}
	r.ended = false
	r.pending += text
}

// endText marks the text so far as finished.
func (r *renderer) endText() {
	if !r.ended && r.pending != "" {
		r.ended, r.endedAt = true, time.Now()
	}
	r.part = ""
}

func (r *renderer) questionnaire(toolID, input string) {
	var args struct {
		Questions []question `json:"questions"`
	}
	if json.Unmarshal([]byte(input), &args) != nil || len(args.Questions) == 0 {
		return
	}
	if t := r.questions[toolID]; t != nil {
		t.Stop()
	}
	qs := args.Questions
	r.questions[toolID] = time.AfterFunc(questionSettle, func() {
		r.mu.Lock()
		if r.questions[toolID] == nil {
			r.mu.Unlock()
			return
		}
		delete(r.questions, toolID)
		r.endText()
		r.flushLocked(true)
		r.mu.Unlock()
		r.asked(toolID, qs)
	})
}

// finish sends what is left once the run ended.
func (r *renderer) finish() {
	close(r.stop)
	<-r.done
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, t := range r.questions {
		t.Stop()
		delete(r.questions, id)
	}
	r.endText()
	r.flushLocked(true)
	if !r.caps.EditMessage {
		_ = r.conn.Typing(context.WithoutCancel(r.ctx), r.to, false)
	}
}

// flushLocked sends or edits what is due; force sends everything.
func (r *renderer) flushLocked(force bool) {
	if r.caps.EditMessage {
		r.flushPreview(force)
		return
	}
	if r.pending == "" {
		return
	}
	if !force && !(r.ended && (len(r.pending) >= blockMin || time.Since(r.endedAt) >= blockIdle)) {
		// A block still streaming goes out once it alone fills messages.
		if len(r.pending) <= r.caps.TextLimit {
			return
		}
		chunks := splitText(r.pending, r.caps.TextLimit)
		for _, c := range chunks[:len(chunks)-1] {
			r.sendLocked(c)
		}
		r.pending = chunks[len(chunks)-1]
		return
	}
	for _, c := range splitText(r.pending, r.caps.TextLimit) {
		r.sendLocked(c)
	}
	r.pending, r.ended = "", false
}

func (r *renderer) flushPreview(force bool) {
	if !force && time.Since(r.lastEdit) < editEvery {
		return
	}
	body := strings.TrimSpace(strings.Join(nonEmpty(r.parts), "\n\n"))
	if body == "" {
		return
	}
	// The first messages' text stops changing once the reply outgrows them,
	// so only the last one keeps being edited.
	for i, c := range splitText(body, r.caps.TextLimit) {
		if i < len(r.msgIDs) {
			if r.shown[i] == c {
				continue
			}
			if err := r.conn.Edit(r.ctx, r.to, r.msgIDs[i], c); err != nil {
				log.Printf("channel: edit: %v", err)
				continue
			}
			r.shown[i] = c
			r.lastEdit = time.Now()
			continue
		}
		id, err := r.conn.Send(r.ctx, r.to, c)
		if err != nil {
			log.Printf("channel: send: %v", err)
			return
		}
		r.msgIDs, r.shown, r.lastEdit = append(r.msgIDs, id), append(r.shown, c), time.Now()
	}
}

func (r *renderer) sendLocked(text string) {
	if !r.caps.Markdown {
		text = plainText(text)
	}
	if strings.TrimSpace(text) == "" {
		return
	}
	if _, err := r.conn.Send(r.ctx, r.to, text); err != nil {
		log.Printf("channel: send: %v", err)
	}
}

func nonEmpty(parts []string) []string {
	out := parts[:0:0]
	for _, p := range parts {
		if strings.TrimSpace(p) != "" {
			out = append(out, p)
		}
	}
	return out
}
