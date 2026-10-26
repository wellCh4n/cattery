// Package skills is the global skill library: a directory of
// `<slug>/SKILL.md (+assets)` folders on the backend's own volume (SKILLS_DIR),
// shared by every project. Sandboxes never mount it; a skill reaches a project
// when it is installed, as a tar of its folder (WriteArchive).
//
// The handlers answer like the files routes of the agent: JSON on success,
// plain-text errors. Routing, auth and the admin-only checks are the API
// router's.
package skills

import (
	"archive/tar"
	"archive/zip"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const (
	maxReadBytes  = 2 * 1024 * 1024
	dirEntryLimit = 2000
	// maxUploadMemory is how much of an upload-zip form stays in memory; the
	// rest spills to temporary files.
	maxUploadMemory = 32 << 20
	manifest        = "SKILL.md"
)

// ErrNoSkill is returned for a library folder without a SKILL.md.
var ErrNoSkill = errors.New("not a skill: missing SKILL.md")

type Library struct {
	root string
}

// Open uses dir as the library, creating it if needed.
func Open(dir string) (*Library, error) {
	root, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	return &Library{root: root}, nil
}

func (l *Library) Root() string { return l.root }

type entry struct {
	Name  string `json:"name"`
	Type  string `json:"type"` // "file" | "dir" | "link"
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"`
}

type readResponse struct {
	Path      string `json:"path"`
	Size      int64  `json:"size"`
	Truncated bool   `json:"truncated"`
	Binary    bool   `json:"binary"`
	Content   string `json:"content,omitempty"`
}

// catalogItem is one entry in the skill-centric catalog: a top-level directory
// under root is one skill, identified by its `<slug>/SKILL.md` frontmatter.
// Valid is false for stray top-level files or folders missing a SKILL.md, so
// the UI can surface them as fixable problems instead of hiding them.
type catalogItem struct {
	Slug        string `json:"slug"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Valid       bool   `json:"valid"`
	Reason      string `json:"reason,omitempty"`
	Mtime       int64  `json:"mtime"`
}

// resolve maps a library path ("/demo/SKILL.md") to an absolute path inside
// the root.
func (l *Library) resolve(rel string) (string, error) {
	abs := filepath.Join(l.root, filepath.Clean("/"+strings.TrimPrefix(rel, "/")))
	if !l.inside(abs) {
		return "", errors.New("path escapes root")
	}
	return abs, nil
}

func (l *Library) inside(abs string) bool {
	return abs == l.root || strings.HasPrefix(abs, l.root+string(os.PathSeparator))
}

// relative turns an absolute path inside the root back into a library path.
func (l *Library) relative(abs string) string {
	rel := strings.TrimPrefix(abs, l.root)
	if rel == "" {
		return "/"
	}
	return filepath.ToSlash(rel)
}

// statError answers a failed stat: 404 when missing, 500 otherwise.
func statError(w http.ResponseWriter, err error) {
	if os.IsNotExist(err) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	http.Error(w, err.Error(), http.StatusInternalServerError)
}

// Catalog answers GET /catalog: the library as a list of skills rather than a
// raw file tree. Each top-level directory is one skill, described by the
// frontmatter of its SKILL.md. Stray top-level files and folders without a
// SKILL.md are returned with Valid=false so the UI can flag them instead of
// hiding them.
func (l *Library) Catalog(w http.ResponseWriter, r *http.Request) {
	if err := cleanupMacJunk(l.root); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	dirents, err := os.ReadDir(l.root)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	out := make([]catalogItem, 0, len(dirents))
	for _, de := range dirents {
		name := de.Name()
		if isMacJunkName(name) {
			continue
		}
		fi, err := de.Info()
		if err != nil {
			continue
		}
		item := catalogItem{Slug: name, Name: name, Mtime: fi.ModTime().Unix()}
		if !fi.IsDir() {
			item.Reason = "not a folder — each skill must be a <slug>/SKILL.md directory"
			out = append(out, item)
			continue
		}
		buf, err := os.ReadFile(filepath.Join(l.root, name, manifest))
		if err != nil {
			item.Reason = "missing SKILL.md"
			out = append(out, item)
			continue
		}
		fm := parseFrontmatter(buf)
		if n := strings.TrimSpace(fm["name"]); n != "" {
			item.Name = n
		}
		item.Description = strings.TrimSpace(fm["description"])
		item.Valid = true
		out = append(out, item)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Valid != out[j].Valid {
			return out[i].Valid // valid skills first, problems sink to the bottom
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	writeJSON(w, out)
}

// parseFrontmatter extracts top-level `key: value` pairs from a YAML frontmatter
// block delimited by a leading and a closing `---` line. Intentionally minimal —
// no nesting or multiline scalars — since skill manifests only carry single-line
// name + description.
func parseFrontmatter(buf []byte) map[string]string {
	out := map[string]string{}
	text := strings.ReplaceAll(string(buf), "\r\n", "\n")
	if !strings.HasPrefix(text, "---\n") {
		return out
	}
	rest := text[len("---\n"):]
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return out
	}
	for _, line := range strings.Split(rest[:end], "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		colon := strings.Index(line, ":")
		if colon <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:colon])
		val := strings.Trim(strings.TrimSpace(line[colon+1:]), `"'`)
		out[key] = val
	}
	return out
}

// List answers GET /list?path=: a directory's entries, folders first.
func (l *Library) List(w http.ResponseWriter, r *http.Request) {
	abs, err := l.resolve(r.URL.Query().Get("path"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	info, err := os.Stat(abs)
	if err != nil {
		statError(w, err)
		return
	}
	if !info.IsDir() {
		http.Error(w, "not a directory", http.StatusBadRequest)
		return
	}
	if err := cleanupMacJunk(abs); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	dirents, err := os.ReadDir(abs)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	out := make([]entry, 0, len(dirents))
	for i, de := range dirents {
		if isMacJunkName(de.Name()) {
			continue
		}
		if i >= dirEntryLimit {
			break
		}
		fi, err := de.Info()
		if err != nil {
			continue
		}
		e := entry{Name: de.Name(), Mtime: fi.ModTime().Unix()}
		switch {
		case fi.Mode()&os.ModeSymlink != 0:
			e.Type = "link"
		case fi.IsDir():
			e.Type = "dir"
		default:
			e.Type = "file"
			e.Size = fi.Size()
		}
		out = append(out, e)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if (out[i].Type == "dir") != (out[j].Type == "dir") {
			return out[i].Type == "dir"
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	writeJSON(w, out)
}

// Read answers GET /read?path=&limit=: a file's content, up to 2 MB, or only
// its size when binary.
func (l *Library) Read(w http.ResponseWriter, r *http.Request) {
	abs, err := l.resolve(r.URL.Query().Get("path"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	info, err := os.Stat(abs)
	if err != nil {
		statError(w, err)
		return
	}
	if info.IsDir() {
		http.Error(w, "is a directory", http.StatusBadRequest)
		return
	}

	limit := int64(maxReadBytes)
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 && n <= maxReadBytes {
			limit = n
		}
	}
	f, err := os.Open(abs)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer f.Close()
	buf, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	truncated := int64(len(buf)) > limit
	if truncated {
		buf = buf[:limit]
	}

	resp := readResponse{
		Path:      r.URL.Query().Get("path"),
		Size:      info.Size(),
		Truncated: truncated,
		Binary:    isBinary(buf),
	}
	if !resp.Binary {
		resp.Content = string(buf)
	}
	writeJSON(w, resp)
}

// SkillDir returns the folder of the library skill slug, which must hold a
// SKILL.md (ErrNoSkill otherwise).
func (l *Library) SkillDir(slug string) (string, error) {
	abs, err := l.resolve(slug)
	if err != nil {
		return "", err
	}
	if abs == l.root {
		return "", ErrNoSkill
	}
	if _, err := os.Stat(filepath.Join(abs, manifest)); err != nil {
		if os.IsNotExist(err) {
			return "", ErrNoSkill
		}
		return "", err
	}
	return abs, nil
}

// WriteArchive writes dir as a tar of its contents, with paths relative to
// dir: the format the agent's /extract installs into ~/.agents/skills/<slug>.
// Only regular files and directories are archived; symlinks and macOS junk
// are skipped.
func WriteArchive(dir string, w io.Writer) error {
	tw := tar.NewWriter(w)
	err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == dir {
			return nil
		}
		if isMacJunkName(d.Name()) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if !info.IsDir() && !info.Mode().IsRegular() {
			return nil
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		hdr, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		hdr.Name = filepath.ToSlash(rel)
		if info.IsDir() {
			hdr.Name += "/"
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = io.Copy(tw, f)
		return err
	})
	if err != nil {
		return err
	}
	return tw.Close()
}

// UploadZip answers POST /upload-zip?path=: a multipart form whose "file" is
// a `<slug>.zip`, extracted into <path>/<slug>, over what is already there.
func (l *Library) UploadZip(w http.ResponseWriter, r *http.Request) {
	destDir, err := l.resolve(r.URL.Query().Get("path"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	info, err := os.Stat(destDir)
	if err != nil {
		statError(w, err)
		return
	}
	if !info.IsDir() {
		http.Error(w, "path is not a directory", http.StatusBadRequest)
		return
	}
	if err := r.ParseMultipartForm(maxUploadMemory); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	f, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "missing file field", http.StatusBadRequest)
		return
	}
	defer f.Close()

	slug, err := SlugFromZip(header.Filename)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	extractDir := filepath.Join(destDir, slug)
	zr, err := zip.NewReader(f, header.Size)
	if err != nil {
		http.Error(w, "invalid zip: "+err.Error(), http.StatusBadRequest)
		return
	}
	if err := os.MkdirAll(extractDir, 0o755); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := cleanupMacJunk(extractDir); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	dirs, files := 1, 0
	for _, ze := range zr.File {
		raw := ze.Name
		if raw == "" || strings.HasPrefix(raw, "/") || strings.Contains(raw, `\`) {
			http.Error(w, "invalid entry path: "+raw, http.StatusBadRequest)
			return
		}
		rel := zipEntry(raw, slug)
		if rel == "" || isMacJunkPath(rel) {
			continue
		}
		dest := filepath.Join(extractDir, rel)
		mode := ze.Mode()
		switch {
		case mode.IsDir():
			if err := os.MkdirAll(dest, 0o755); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			dirs++
		case !mode.IsRegular():
			http.Error(w, "unsupported entry type: "+raw, http.StatusBadRequest)
			return
		default:
			if err := extractFile(ze, dest); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			files++
		}
	}
	writeJSON(w, map[string]interface{}{
		"path":  l.relative(extractDir),
		"dirs":  dirs,
		"files": files,
	})
}

func extractFile(ze *zip.File, dest string) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	rc, err := ze.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, rc); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// Delete answers DELETE /delete?path=, recursive for directories.
func (l *Library) Delete(w http.ResponseWriter, r *http.Request) {
	abs, err := l.resolve(r.URL.Query().Get("path"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if abs == l.root {
		http.Error(w, "cannot delete root", http.StatusBadRequest)
		return
	}
	if _, err := os.Lstat(abs); err != nil {
		statError(w, err)
		return
	}
	if err := os.RemoveAll(abs); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// baseName validates a new file or folder name: one path segment.
func baseName(name string) (string, bool) {
	if strings.ContainsAny(name, `/\`) {
		return "", false
	}
	cleaned := filepath.Base(filepath.Clean("/" + name))
	return cleaned, cleaned != "" && cleaned != "." && cleaned != "/" && cleaned != ".."
}

// Rename answers POST /rename?from=&to=, renaming within the same folder.
func (l *Library) Rename(w http.ResponseWriter, r *http.Request) {
	from, err := l.resolve(r.URL.Query().Get("from"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if from == l.root {
		http.Error(w, "cannot rename root", http.StatusBadRequest)
		return
	}
	if r.URL.Query().Get("to") == "" {
		http.Error(w, "missing 'to'", http.StatusBadRequest)
		return
	}
	name, ok := baseName(r.URL.Query().Get("to"))
	if !ok {
		http.Error(w, "invalid 'to'", http.StatusBadRequest)
		return
	}
	to := filepath.Join(filepath.Dir(from), name)
	if _, err := os.Lstat(from); err != nil {
		statError(w, err)
		return
	}
	if _, err := os.Lstat(to); err == nil {
		http.Error(w, "destination already exists", http.StatusConflict)
		return
	} else if !os.IsNotExist(err) {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := os.Rename(from, to); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]interface{}{"path": l.relative(to), "name": name})
}

// Mkdir answers POST /mkdir?path=&name=.
func (l *Library) Mkdir(w http.ResponseWriter, r *http.Request) {
	parent, err := l.resolve(r.URL.Query().Get("path"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	info, err := os.Stat(parent)
	if err != nil {
		statError(w, err)
		return
	}
	if !info.IsDir() {
		http.Error(w, "path is not a directory", http.StatusBadRequest)
		return
	}
	name, ok := baseName(r.URL.Query().Get("name"))
	if !ok {
		http.Error(w, "invalid 'name'", http.StatusBadRequest)
		return
	}
	dest := filepath.Join(parent, name)
	if err := os.Mkdir(dest, 0o755); err != nil {
		if os.IsExist(err) {
			http.Error(w, "destination already exists", http.StatusConflict)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]interface{}{"path": l.relative(dest), "name": name})
}

func isBinary(buf []byte) bool {
	n := len(buf)
	if n > 8000 {
		n = 8000
	}
	for _, b := range buf[:n] {
		if b == 0 {
			return true
		}
	}
	return false
}

func cleanupMacJunk(dir string) error {
	return filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == dir || !isMacJunkName(d.Name()) {
			return nil
		}
		if err := os.RemoveAll(path); err != nil {
			return err
		}
		if d.IsDir() {
			return filepath.SkipDir
		}
		return nil
	})
}

func writeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
