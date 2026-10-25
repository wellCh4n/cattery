package main

import (
	"archive/tar"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

func TestHandleArchive(t *testing.T) {
	oldRoot := root
	root = t.TempDir()
	t.Cleanup(func() { root = oldRoot })
	for name, body := range map[string]string{"demo/SKILL.md": "skill", "demo/refs/a.md": "a", "demo/.DS_Store": "junk", "plain/readme": "x"} {
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink("/etc/passwd", filepath.Join(root, "demo/link")); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	handleArchive(rec, httptest.NewRequest(http.MethodGet, "/archive?path=/demo", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("archive: %d %s", rec.Code, rec.Body)
	}
	var names []string
	tr := tar.NewReader(rec.Body)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, hdr.Name)
	}
	sort.Strings(names)
	if got := strings.Join(names, ","); got != "SKILL.md,refs/,refs/a.md" {
		t.Fatalf("entries = %s", got)
	}

	for _, path := range []string{"/", "/plain", "/missing", "/../etc"} {
		rec := httptest.NewRecorder()
		handleArchive(rec, httptest.NewRequest(http.MethodGet, "/archive?path="+path, nil))
		if rec.Code == http.StatusOK {
			t.Fatalf("archive %s succeeded", path)
		}
	}
}

func TestCleanZipEntry(t *testing.T) {
	for raw, want := range map[string]string{
		"demo/":         "",
		"demo/SKILL.md": "SKILL.md",
		"demo/refs/":    "refs",
		"SKILL.md":      "SKILL.md",
		"other/x.md":    "other/x.md",
	} {
		if got := cleanZipEntry(raw, "demo"); got != want {
			t.Errorf("cleanZipEntry(%q) = %q, want %q", raw, got, want)
		}
	}
}
