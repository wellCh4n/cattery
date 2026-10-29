package channel

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

const fenceClose = "\n```"

// splitText cuts text into messages of at most limit bytes. It breaks at a
// paragraph, else a line, a sentence or a space, and never inside a rune. A
// code block cut in two is closed at the end of one message and reopened at
// the start of the next, so each renders on its own.
func splitText(text string, limit int) []string {
	var out []string
	fence := "" // the opening line of a code block still open
	for text != "" {
		prefix := ""
		if fence != "" {
			prefix = fence + "\n"
		}
		budget := limit - len(prefix)
		if len(text) <= budget {
			out = append(out, prefix+text)
			break
		}
		cut := breakAt(text, max(budget-len(fenceClose), 1))
		chunk := strings.TrimRight(text[:cut], " \n")
		open := fenceAfter(fence, chunk)
		piece := prefix + chunk
		if open != "" {
			piece += fenceClose
		}
		if strings.TrimSpace(chunk) != "" {
			out = append(out, piece)
		}
		fence = open
		text = strings.TrimLeft(text[cut:], "\n")
	}
	return out
}

// breakAt is where to cut s to keep at most n bytes.
func breakAt(s string, n int) int {
	if n >= len(s) {
		return len(s)
	}
	head := s[:n]
	if i := strings.LastIndex(head, "\n\n"); i > n/2 {
		return i + 2
	}
	if i := strings.LastIndex(head, "\n"); i > n/3 {
		return i + 1
	}
	best := -1
	for _, end := range []string{"。", "！", "？", ". ", "! ", "? ", "; ", "；"} {
		if i := strings.LastIndex(head, end); i >= 0 && i+len(end) > best {
			best = i + len(end)
		}
	}
	if best > n/3 {
		return best
	}
	if i := strings.LastIndex(head, " "); i > n/3 {
		return i + 1
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	if n == 0 {
		_, size := utf8.DecodeRuneInString(s)
		return size
	}
	return n
}

// fenceAfter is the code block open at the end of chunk, given the one open
// at its start ("" for none).
func fenceAfter(open, chunk string) string {
	for line := range strings.SplitSeq(chunk, "\n") {
		t := strings.TrimSpace(line)
		if !strings.HasPrefix(t, "```") {
			continue
		}
		if open == "" {
			open = t
		} else {
			open = ""
		}
	}
	return open
}

var (
	mdLink    = regexp.MustCompile(`!?\[([^\]]*)\]\(([^)\s]+)\)`)
	mdEmph    = regexp.MustCompile(`(\*\*|__)(\S(?:.*?\S)?)(\*\*|__)`)
	mdCode    = regexp.MustCompile("`([^`\n]+)`")
	mdHeading = regexp.MustCompile(`^#{1,6}\s+`)
)

// plainText turns Markdown into text for chats that do not render it: code
// blocks keep their code but lose their fences, links show their address.
func plainText(md string) string {
	var b strings.Builder
	inFence := false
	for i, line := range strings.Split(md, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "```") {
			inFence = !inFence
			continue
		}
		if i > 0 && b.Len() > 0 {
			b.WriteByte('\n')
		}
		if inFence {
			b.WriteString(line)
			continue
		}
		line = mdHeading.ReplaceAllString(line, "")
		line = mdLink.ReplaceAllStringFunc(line, func(m string) string {
			parts := mdLink.FindStringSubmatch(m)
			if parts[1] == "" || parts[1] == parts[2] {
				return parts[2]
			}
			return parts[1] + " (" + parts[2] + ")"
		})
		line = mdEmph.ReplaceAllString(line, "$2")
		line = mdCode.ReplaceAllString(line, "$1")
		b.WriteString(line)
	}
	return b.String()
}
