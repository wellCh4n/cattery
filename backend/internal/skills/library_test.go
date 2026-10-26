package skills

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func testLibrary(t *testing.T, files map[string]string) *Library {
	t.Helper()
	lib, err := Open(filepath.Join(t.TempDir(), "skills"))
	if err != nil {
		t.Fatal(err)
	}
	for name, body := range files {
		path := filepath.Join(lib.Root(), name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return lib
}

func serve(handler http.HandlerFunc, method, target string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	handler(rec, httptest.NewRequest(method, target, nil))
	return rec
}

func TestArchive(t *testing.T) {
	lib := testLibrary(t, map[string]string{"demo/SKILL.md": "skill", "demo/refs/a.md": "a", "demo/.DS_Store": "junk", "plain/readme": "x"})
	if err := os.Symlink("/etc/passwd", filepath.Join(lib.Root(), "demo/link")); err != nil {
		t.Fatal(err)
	}
	dir, err := lib.SkillDir("demo")
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := WriteArchive(dir, &buf); err != nil {
		t.Fatal(err)
	}
	if got := tarNames(t, &buf); got != "SKILL.md,refs/,refs/a.md" {
		t.Fatalf("entries = %s", got)
	}
	for _, slug := range []string{"", "/", "plain", "missing", "../etc"} {
		if _, err := lib.SkillDir(slug); !errors.Is(err, ErrNoSkill) {
			t.Fatalf("SkillDir(%q) = %v", slug, err)
		}
	}
}

func TestCatalog(t *testing.T) {
	lib := testLibrary(t, map[string]string{
		"demo/SKILL.md": "---\nname: Demo\ndescription: \"Does things\"\n---\nbody",
		"broken/x.md":   "x",
		"stray.txt":     "x",
		"._junk":        "x",
	})
	rec := serve(lib.Catalog, http.MethodGet, "/catalog")
	var items []catalogItem
	if err := json.Unmarshal(rec.Body.Bytes(), &items); err != nil {
		t.Fatal(rec.Body.String())
	}
	if len(items) != 3 || items[0].Slug != "demo" || items[0].Name != "Demo" || items[0].Description != "Does things" || !items[0].Valid {
		t.Fatalf("%+v", items)
	}
	for _, item := range items[1:] {
		if item.Valid || item.Reason == "" {
			t.Fatalf("problem not flagged: %+v", item)
		}
	}
	if _, err := os.Stat(filepath.Join(lib.Root(), "._junk")); !os.IsNotExist(err) {
		t.Fatal("macOS junk kept")
	}
}

func TestPathsStayInside(t *testing.T) {
	lib := testLibrary(t, map[string]string{"demo/SKILL.md": "skill"})
	outside := filepath.Join(filepath.Dir(lib.Root()), "secret")
	if err := os.WriteFile(outside, []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	if rec := serve(lib.Read, http.MethodGet, "/read?path=../secret"); rec.Code != http.StatusNotFound {
		t.Fatalf("read outside: %d %s", rec.Code, rec.Body)
	}
	if rec := serve(lib.Read, http.MethodGet, "/read?path=/demo/SKILL.md"); rec.Code != http.StatusOK || !bytes.Contains(rec.Body.Bytes(), []byte(`"content":"skill"`)) {
		t.Fatalf("read: %d %s", rec.Code, rec.Body)
	}
	for _, target := range []string{"/delete?path=/", "/delete?path=.."} {
		if rec := serve(lib.Delete, http.MethodDelete, target); rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: %d", target, rec.Code)
		}
	}
	for _, target := range []string{"/rename?from=/demo&to=../x", "/rename?from=/demo&to=..", "/rename?from=/&to=x"} {
		if rec := serve(lib.Rename, http.MethodPost, target); rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: %d", target, rec.Code)
		}
	}
	if rec := serve(lib.Mkdir, http.MethodPost, "/mkdir?path=/&name=a/b"); rec.Code != http.StatusBadRequest {
		t.Fatalf("mkdir a/b: %d", rec.Code)
	}
}

func TestManage(t *testing.T) {
	lib := testLibrary(t, nil)
	if rec := serve(lib.Mkdir, http.MethodPost, "/mkdir?path=/&name=empty"); rec.Code != http.StatusOK || !bytes.Contains(rec.Body.Bytes(), []byte(`"path":"/empty"`)) {
		t.Fatalf("mkdir: %d %s", rec.Code, rec.Body)
	}
	if rec := serve(lib.Mkdir, http.MethodPost, "/mkdir?path=/&name=empty"); rec.Code != http.StatusConflict {
		t.Fatalf("mkdir twice: %d", rec.Code)
	}

	var zipped bytes.Buffer
	zw := zip.NewWriter(&zipped)
	for _, name := range []string{"demo/", "demo/SKILL.md", "demo/refs/a.md", "__MACOSX/demo/._SKILL.md"} {
		w, _ := zw.Create(name)
		_, _ = w.Write([]byte("x"))
	}
	zw.Close()
	var form bytes.Buffer
	mw := multipart.NewWriter(&form)
	part, _ := mw.CreateFormFile("file", "demo.zip")
	_, _ = part.Write(zipped.Bytes())
	mw.Close()
	req := httptest.NewRequest(http.MethodPost, "/upload-zip?path=/", &form)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rec := httptest.NewRecorder()
	lib.UploadZip(rec, req)
	if rec.Code != http.StatusOK || !bytes.Contains(rec.Body.Bytes(), []byte(`"path":"/demo"`)) {
		t.Fatalf("upload: %d %s", rec.Code, rec.Body)
	}
	if _, err := lib.SkillDir("demo"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(lib.Root(), "__MACOSX")); !os.IsNotExist(err) {
		t.Fatal("macOS junk extracted")
	}

	if rec := serve(lib.Rename, http.MethodPost, "/rename?from=/demo&to=empty"); rec.Code != http.StatusConflict {
		t.Fatalf("rename over existing: %d", rec.Code)
	}
	if rec := serve(lib.Rename, http.MethodPost, "/rename?from=/demo&to=renamed"); rec.Code != http.StatusOK || !bytes.Contains(rec.Body.Bytes(), []byte(`"path":"/renamed"`)) {
		t.Fatalf("rename: %d %s", rec.Code, rec.Body)
	}
	if rec := serve(lib.List, http.MethodGet, "/list?path=/renamed"); rec.Code != http.StatusOK || !bytes.HasPrefix(rec.Body.Bytes(), []byte(`[{"name":"refs","type":"dir"`)) {
		t.Fatalf("list: %d %s", rec.Code, rec.Body)
	}
	if rec := serve(lib.Delete, http.MethodDelete, "/delete?path=/renamed"); rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d", rec.Code)
	}
	if rec := serve(lib.Delete, http.MethodDelete, "/delete?path=/renamed"); rec.Code != http.StatusNotFound {
		t.Fatalf("delete twice: %d", rec.Code)
	}
}
