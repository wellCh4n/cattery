package channel

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestSplitTextKeepsShortTextWhole(t *testing.T) {
	got := splitText("hello\n\nworld", 100)
	if len(got) != 1 || got[0] != "hello\n\nworld" {
		t.Fatalf("got %q", got)
	}
}

func TestSplitTextPrefersParagraphs(t *testing.T) {
	text := strings.Repeat("a", 60) + "\n\n" + strings.Repeat("b", 60)
	got := splitText(text, 100)
	if len(got) != 2 || got[0] != strings.Repeat("a", 60) || got[1] != strings.Repeat("b", 60) {
		t.Fatalf("got %q", got)
	}
}

func TestSplitTextNeverCutsARune(t *testing.T) {
	text := strings.Repeat("修复登录问题", 50)
	for _, part := range splitText(text, 64) {
		if len(part) > 64 || !utf8.ValidString(part) {
			t.Fatalf("bad part %q (%d bytes)", part, len(part))
		}
	}
	if strings.Join(splitText(text, 64), "") != text {
		t.Fatal("text lost")
	}
}

func TestSplitTextReopensCodeBlocks(t *testing.T) {
	var lines []string
	for range 40 {
		lines = append(lines, "fmt.Println(1)")
	}
	text := "Run this:\n\n```go\n" + strings.Join(lines, "\n") + "\n```\nDone."
	parts := splitText(text, 200)
	if len(parts) < 3 {
		t.Fatalf("want several parts, got %d", len(parts))
	}
	for i, part := range parts {
		if len(part) > 200 {
			t.Fatalf("part %d is %d bytes", i, len(part))
		}
		if strings.Count(part, "```")%2 != 0 {
			t.Fatalf("part %d leaves a code block open: %q", i, part)
		}
	}
	if !strings.HasPrefix(parts[1], "```go\n") {
		t.Fatalf("second part does not reopen the block: %q", parts[1])
	}
}

func TestPlainText(t *testing.T) {
	md := "## Steps\n\nSee **the docs** at [Cattery](https://example.com) and run `make dev`:\n\n```bash\nmake dev\n```"
	want := "Steps\n\nSee the docs at Cattery (https://example.com) and run make dev:\n\nmake dev"
	if got := plainText(md); got != want {
		t.Fatalf("got %q\nwant %q", got, want)
	}
}
