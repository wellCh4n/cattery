package api

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/wellch4n/cattery/internal/harness"
	"github.com/wellch4n/cattery/internal/model"
)

var slugStripper = regexp.MustCompile(`[^a-zA-Z0-9-_]+`)

// exportFilename builds a safe filename like "fix-login-flow-a1b2c3d4.md".
// Falls back to the session UUID head when the title is empty or unprintable.
func exportFilename(sess *model.Session, ext string) string {
	title := ""
	if sess.Title != nil {
		title = strings.TrimSpace(*sess.Title)
	}
	slug := slugStripper.ReplaceAllString(strings.ReplaceAll(strings.ToLower(title), " ", "-"), "")
	slug = strings.Trim(slug, "-")
	if len(slug) > 60 {
		slug = slug[:60]
	}
	head := sess.SessionID.String()
	if len(head) > 8 {
		head = head[:8]
	}
	if slug == "" {
		return fmt.Sprintf("session-%s.%s", head, ext)
	}
	return fmt.Sprintf("%s-%s.%s", slug, head, ext)
}

// renderTranscriptMarkdown turns the platform-format history into a human
// readable markdown transcript. Tool start/done are paired by toolId; deltas
// of the same partId are concatenated. Order within a message is preserved.
func renderTranscriptMarkdown(sess *model.Session, h *model.Harness, items []harness.PlatformHistoryItem) string {
	var b strings.Builder

	title := "Session"
	if sess.Title != nil && strings.TrimSpace(*sess.Title) != "" {
		title = strings.TrimSpace(*sess.Title)
	}
	fmt.Fprintf(&b, "# %s\n\n", title)

	harnessName := "Untitled"
	if h.HarnessName != nil && strings.TrimSpace(*h.HarnessName) != "" {
		harnessName = strings.TrimSpace(*h.HarnessName)
	}
	fmt.Fprintf(&b, "- **Harness**: %s (`%s`)\n", harnessName, h.Type)
	fmt.Fprintf(&b, "- **Model**: `%s`\n", h.Model)
	fmt.Fprintf(&b, "- **Session ID**: `%s`\n", sess.SessionID)
	fmt.Fprintf(&b, "- **Created**: %s\n", sess.CreatedAt.Format("2006-01-02 15:04:05 MST"))
	b.WriteString("\n---\n\n")

	for _, item := range items {
		renderItemMarkdown(&b, item)
	}
	return b.String()
}

func renderItemMarkdown(b *strings.Builder, item harness.PlatformHistoryItem) {
	role := capitalize(strings.ToLower(item.Role))
	if role == "" {
		role = "Message"
	}
	fmt.Fprintf(b, "## %s\n\n", role)

	// Coalesce message.delta by partId so we render one block per part instead
	// of many tiny chunks. Order is preserved by tracking first-seen index.
	textOrder := []string{}
	textBuf := map[string]*strings.Builder{}
	thinkOrder := []string{}
	thinkBuf := map[string]*strings.Builder{}
	toolStart := map[string]harness.ToolStartData{}
	// renderedTools lets us emit each tool inline at the first event that
	// "completes" it (a done, or just the start if no done arrives).
	rendered := map[string]bool{}

	flushTexts := func() {
		for _, id := range textOrder {
			text := strings.TrimRight(textBuf[id].String(), "\n")
			if text == "" {
				continue
			}
			b.WriteString(text)
			b.WriteString("\n\n")
		}
		textOrder = textOrder[:0]
		textBuf = map[string]*strings.Builder{}
	}
	flushThinking := func() {
		for _, id := range thinkOrder {
			text := strings.TrimRight(thinkBuf[id].String(), "\n")
			if text == "" {
				continue
			}
			b.WriteString("> 💭 ")
			b.WriteString(strings.ReplaceAll(text, "\n", "\n> "))
			b.WriteString("\n\n")
		}
		thinkOrder = thinkOrder[:0]
		thinkBuf = map[string]*strings.Builder{}
	}

	for _, ev := range item.Events {
		switch ev.Type {
		case harness.EventMessageDelta:
			var d harness.MessageDeltaData
			_ = json.Unmarshal(ev.Data, &d)
			if _, ok := textBuf[d.PartID]; !ok {
				textOrder = append(textOrder, d.PartID)
				textBuf[d.PartID] = &strings.Builder{}
			}
			textBuf[d.PartID].WriteString(d.Text)

		case harness.EventMessageThinking:
			var d harness.MessageDeltaData
			_ = json.Unmarshal(ev.Data, &d)
			if _, ok := thinkBuf[d.PartID]; !ok {
				thinkOrder = append(thinkOrder, d.PartID)
				thinkBuf[d.PartID] = &strings.Builder{}
			}
			thinkBuf[d.PartID].WriteString(d.Text)

		case harness.EventToolStart:
			var d harness.ToolStartData
			_ = json.Unmarshal(ev.Data, &d)
			toolStart[d.ToolID] = d

		case harness.EventToolDone:
			flushTexts()
			flushThinking()
			var d harness.ToolDoneData
			_ = json.Unmarshal(ev.Data, &d)
			start, hasStart := toolStart[d.ToolID]
			renderTool(b, start, hasStart, d, true)
			rendered[d.ToolID] = true

		case harness.EventQuestionAsked:
			flushTexts()
			flushThinking()
			b.WriteString("> ❓ **Question to user**\n>\n> ")
			b.Write(prettyJSON(ev.Data))
			b.WriteString("\n\n")

		case harness.EventQuestionAnswered:
			b.WriteString("> ✅ **User answer**\n>\n> ")
			b.Write(prettyJSON(ev.Data))
			b.WriteString("\n\n")
		}
	}

	flushTexts()
	flushThinking()

	// Tool calls with a start but no done — render them as "in-flight".
	for id, start := range toolStart {
		if rendered[id] {
			continue
		}
		renderTool(b, start, true, harness.ToolDoneData{ToolID: id, Tool: start.Tool}, false)
	}
}

func renderTool(b *strings.Builder, start harness.ToolStartData, hasStart bool, done harness.ToolDoneData, finished bool) {
	name := done.Tool
	if name == "" {
		name = start.Tool
	}
	if name == "" {
		name = "tool"
	}
	status := ""
	if !finished {
		status = " _(in-flight)_"
	}
	fmt.Fprintf(b, "### 🔧 `%s`%s\n\n", name, status)

	if hasStart && strings.TrimSpace(start.Input) != "" {
		b.WriteString("**input**\n\n")
		writeFenced(b, "", start.Input)
	}
	if strings.TrimSpace(done.Output) != "" {
		b.WriteString("**output**\n\n")
		writeFenced(b, "", done.Output)
	}
	if done.Parsed != nil {
		raw, err := json.MarshalIndent(done.Parsed, "", "  ")
		if err == nil && len(raw) > 0 && string(raw) != "null" {
			b.WriteString("**parsed**\n\n")
			writeFenced(b, "json", string(raw))
		}
	}
	b.WriteString("\n")
}

func writeFenced(b *strings.Builder, lang, body string) {
	body = strings.TrimRight(body, "\n")
	// Pick a fence longer than any run of backticks in the body so we don't
	// have to escape internal triple-backticks (common in tool output).
	fence := "```"
	for strings.Contains(body, fence) {
		fence += "`"
	}
	b.WriteString(fence)
	if lang != "" {
		b.WriteString(lang)
	}
	b.WriteByte('\n')
	b.WriteString(body)
	b.WriteByte('\n')
	b.WriteString(fence)
	b.WriteString("\n\n")
}

func capitalize(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

func prettyJSON(raw json.RawMessage) []byte {
	if len(raw) == 0 {
		return []byte("(none)")
	}
	var pretty []byte
	var v any
	if err := json.Unmarshal(raw, &v); err == nil {
		pretty, _ = json.MarshalIndent(v, "> ", "  ")
		if len(pretty) > 0 {
			return pretty
		}
	}
	return raw
}
