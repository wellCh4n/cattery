package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLatexPreviewLifecycle(t *testing.T) {
	oldRoot := root
	root = t.TempDir()
	// macOS temp paths can have an alias; production uses /home/cattery.
	root, _ = filepath.EvalSymlinks(root)
	t.Cleanup(func() { root = oldRoot })
	source := filepath.Join(root, "main.tex")
	dep := filepath.Join(root, "chapter.tex")
	os.WriteFile(source, []byte("first"), 0644)
	os.WriteFile(dep, []byte("chapter"), 0644)
	bin := t.TempDir()
	compiler := `#!/bin/sh
for arg in "$@"; do
 case "$arg" in -output-directory=*) out="${arg#*=}";; esac
done
if [ -f hang ]; then sleep 30; fi
if [ -f fail ]; then echo 'invalid document'; exit 1; fi
printf '%%PDF-1.4 success' > "$out/preview.pdf"
printf 'INPUT ./main.tex\nINPUT ./chapter.tex\n' > "$out/preview.fls"
`
	os.WriteFile(filepath.Join(bin, "xelatex"), []byte(compiler), 0755)
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	request := func(method string) *httptest.ResponseRecorder {
		t.Helper()
		w := httptest.NewRecorder()
		handleLatex(w, httptest.NewRequest(method, "/latex?path=/main.tex", nil))
		return w
	}
	state := func(w *httptest.ResponseRecorder) latexState {
		t.Helper()
		if w.Code != 200 {
			t.Fatalf("status %d: %s", w.Code, w.Body.String())
		}
		var s latexState
		if err := json.Unmarshal(w.Body.Bytes(), &s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	if s := state(request(http.MethodGet)); s.PDF != "" {
		t.Fatal("unexpected preview")
	}
	os.WriteFile(filepath.Join(root, "main.pdf"), []byte("existing PDF"), 0644)
	if s := state(request(http.MethodGet)); s.PDF != "/main.pdf" {
		t.Fatal("sibling PDF not reused")
	}
	first := state(request(http.MethodPost))
	if first.PDF == "" || first.Stale {
		t.Fatalf("invalid compiled state: %+v", first)
	}
	cached := state(request(http.MethodGet))
	if cached.Version != first.Version || cached.Stale {
		t.Fatal("cache not reused")
	}
	os.WriteFile(dep, []byte("changed dependency"), 0644)
	if !state(request(http.MethodGet)).Stale {
		t.Fatal("dependency change not detected")
	}
	state(request(http.MethodPost))
	os.WriteFile(source, []byte("changed source"), 0644)
	if !state(request(http.MethodGet)).Stale {
		t.Fatal("source change not detected")
	}
	before := state(request(http.MethodGet))
	os.WriteFile(filepath.Join(root, "fail"), nil, 0644)
	if w := request(http.MethodPost); w.Code != 422 {
		t.Fatalf("wanted compile error: %d", w.Code)
	}
	after := state(request(http.MethodGet))
	if before.Version != after.Version || before.PDF != after.PDF {
		t.Fatal("failure replaced previous preview")
	}
	os.Remove(filepath.Join(root, "fail"))
	os.WriteFile(filepath.Join(root, "hang"), nil, 0644)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	cancelled := httptest.NewRecorder()
	start := time.Now()
	handleLatex(cancelled, httptest.NewRequest(http.MethodPost, "/latex?path=/main.tex", nil).WithContext(ctx))
	if cancelled.Code != 422 || time.Since(start) > 3*time.Second {
		t.Fatal("compiler did not cancel promptly")
	}
	if state(request(http.MethodGet)).Version != before.Version {
		t.Fatal("cancelled compile replaced PDF")
	}
	latexSlot <- struct{}{}
	w := request(http.MethodPost)
	<-latexSlot
	if w.Code != 409 {
		t.Fatal("concurrent compilation accepted")
	}
}

func TestLatexRejectsOutsideSymlink(t *testing.T) {
	oldRoot := root
	root = t.TempDir()
	t.Cleanup(func() { root = oldRoot })
	outside := filepath.Join(t.TempDir(), "outside.tex")
	os.WriteFile(outside, []byte("outside"), 0644)
	os.Symlink(outside, filepath.Join(root, "main.tex"))
	if _, _, err := latexPaths("/main.tex"); err == nil {
		t.Fatal("accepted external symlink")
	}
}
