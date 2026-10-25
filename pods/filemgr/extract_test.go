package main

import (
	"archive/tar"
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func tarOf(t *testing.T, files map[string]string) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for name, body := range files {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	return &buf
}

func TestHandleExtract(t *testing.T) {
	oldRoot := root
	root = t.TempDir()
	t.Cleanup(func() { root = oldRoot })

	extract := func(body *bytes.Buffer) int {
		rec := httptest.NewRecorder()
		handleExtract(rec, httptest.NewRequest(http.MethodPost, "/extract?path=/.agents/skills/demo", body))
		return rec.Code
	}
	if code := extract(tarOf(t, map[string]string{"SKILL.md": "v1", "assets/a.txt": "a", "stale.txt": "x"})); code != http.StatusOK {
		t.Fatalf("first extract: %d", code)
	}
	// Reinstalling replaces the folder: files missing from the new archive go.
	if code := extract(tarOf(t, map[string]string{"SKILL.md": "v2"})); code != http.StatusOK {
		t.Fatalf("second extract: %d", code)
	}
	dir := filepath.Join(root, ".agents/skills/demo")
	if got, _ := os.ReadFile(filepath.Join(dir, "SKILL.md")); string(got) != "v2" {
		t.Fatalf("SKILL.md = %q", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "stale.txt")); !os.IsNotExist(err) {
		t.Fatal("stale file survived reinstall")
	}
	// A broken archive leaves the installed folder as it was.
	if code := extract(bytes.NewBufferString("not a tar archive at all, padded to a block" + string(make([]byte, 600)))); code != http.StatusBadRequest {
		t.Fatalf("broken extract: %d", code)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "SKILL.md")); string(got) != "v2" {
		t.Fatal("broken archive replaced the installed folder")
	}
	entries, _ := os.ReadDir(filepath.Dir(dir))
	if len(entries) != 1 {
		t.Fatalf("leftover temp dirs: %v", entries)
	}
	if code := extract(tarOf(t, map[string]string{"../../escape.txt": "x"})); code != http.StatusOK {
		t.Fatalf("cleaned escape: %d", code)
	}
	if _, err := os.Stat(filepath.Join(root, ".agents/escape.txt")); !os.IsNotExist(err) {
		t.Fatal("entry escaped the destination")
	}
}
