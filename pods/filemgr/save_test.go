package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHandleSave(t *testing.T) {
	oldRoot := root
	root = t.TempDir()
	t.Cleanup(func() { root = oldRoot })
	file := filepath.Join(root, "a.txt")
	if err := os.WriteFile(file, []byte("old"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("a.txt", filepath.Join(root, "link.txt")); err != nil {
		t.Fatal(err)
	}
	// The web client passes back the mtime /read reported. It must be a JSON
	// string: as a number it would lose precision in JavaScript.
	rec := httptest.NewRecorder()
	handleRead(rec, httptest.NewRequest(http.MethodGet, "/read?path=/link.txt", nil))
	var read map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &read); err != nil {
		t.Fatal(err)
	}
	mtime, ok := read["mtime"].(string)
	if !ok {
		t.Fatalf("mtime is %T, want string", read["mtime"])
	}

	put := func(path, mtime, body string) int {
		url := "/save?path=" + path
		if mtime != "" {
			url += "&mtime=" + mtime
		}
		rec := httptest.NewRecorder()
		handleSave(rec, httptest.NewRequest(http.MethodPut, url, strings.NewReader(body)))
		return rec.Code
	}

	if code := put("/link.txt", mtime, "new"); code != http.StatusOK {
		t.Fatalf("save: got %d", code)
	}
	got, _ := os.ReadFile(file)
	if string(got) != "new" {
		t.Fatalf("content = %q", got)
	}
	if fi, _ := os.Lstat(filepath.Join(root, "link.txt")); fi.Mode()&os.ModeSymlink == 0 {
		t.Fatal("symlink replaced by a regular file")
	}
	if fi, _ := os.Stat(file); fi.Mode().Perm() != 0o640 {
		t.Fatalf("mode = %v", fi.Mode().Perm())
	}
	if code := put("/a.txt", "1", "stale"); code != http.StatusConflict {
		t.Fatalf("stale save: got %d", code)
	}
	if code := put("/missing.txt", "", "x"); code != http.StatusNotFound {
		t.Fatalf("missing file: got %d", code)
	}
	if code := put("/../etc/passwd", "", "x"); code != http.StatusNotFound {
		t.Fatalf("escape: got %d", code)
	}
	entries, _ := os.ReadDir(root)
	if len(entries) != 2 {
		t.Fatalf("leftover temp files: %v", entries)
	}
}
