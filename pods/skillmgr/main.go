// skillmgr: tiny HTTP API for the global skill library.
// Mounts the skills PVC at /skills. Internal-only; reached through the
// backend proxy, never exposed externally.
package main

import (
	"archive/zip"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const (
	defaultRoot   = "/skills"
	defaultPort   = "1116"
	maxReadBytes  = 2 * 1024 * 1024
	dirEntryLimit = 2000
)

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

var root string

func main() {
	root = os.Getenv("SKILLMGR_ROOT")
	if root == "" {
		root = defaultRoot
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = defaultPort
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/list", handleList)
	mux.HandleFunc("/read", handleRead)
	mux.HandleFunc("/upload-zip", handleUploadZip)
	mux.HandleFunc("/delete", handleDelete)
	mux.HandleFunc("/rename", handleRename)
	mux.HandleFunc("/mkdir", handleMkdir)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	addr := "0.0.0.0:" + port
	log.Printf("skillmgr listening on %s, root=%s", addr, root)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("listen: %v", err)
	}
}

func resolve(rel string) (string, error) {
	cleaned := filepath.Clean("/" + strings.TrimPrefix(rel, "/"))
	abs := filepath.Join(root, cleaned)
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	if abs != rootAbs && !strings.HasPrefix(abs, rootAbs+string(os.PathSeparator)) {
		return "", errors.New("path escapes root")
	}
	return abs, nil
}

func handleList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	abs, err := resolve(r.URL.Query().Get("path"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	info, err := os.Stat(abs)
	if err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
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

func handleRead(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	abs, err := resolve(r.URL.Query().Get("path"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	info, err := os.Stat(abs)
	if err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
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

func handleUploadZip(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	destDir, err := resolve(r.URL.Query().Get("path"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	info, err := os.Stat(destDir)
	if err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if !info.IsDir() {
		http.Error(w, "path is not a directory", http.StatusBadRequest)
		return
	}

	if err := r.ParseMultipartForm(32 << 20); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	f, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "missing file field", http.StatusBadRequest)
		return
	}
	defer f.Close()

	skillDirName, err := skillDirNameFromZip(header.Filename)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	extractDir := filepath.Join(destDir, skillDirName)
	if extractDir != destDir && !strings.HasPrefix(extractDir, destDir+string(os.PathSeparator)) {
		http.Error(w, "zip filename escapes destination", http.StatusBadRequest)
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

	ra, ok := f.(io.ReaderAt)
	size := header.Size
	if !ok {
		tmp, err := os.CreateTemp("", "skillmgr-zip-*")
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		defer os.Remove(tmp.Name())
		defer tmp.Close()
		n, err := io.Copy(tmp, f)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		size = n
		if _, err := tmp.Seek(0, io.SeekStart); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		ra = tmp
	}

	zr, err := zip.NewReader(ra, size)
	if err != nil {
		http.Error(w, "invalid zip: "+err.Error(), http.StatusBadRequest)
		return
	}

	dirs, files := 1, 0
	for _, ze := range zr.File {
		raw := ze.Name
		if raw == "" || strings.HasPrefix(raw, "/") || strings.Contains(raw, "\\") {
			http.Error(w, "invalid entry path: "+raw, http.StatusBadRequest)
			return
		}
		entryRel := cleanZipEntry(raw, skillDirName)
		if entryRel == "" {
			continue
		}
		if isMacJunkEntry(entryRel) {
			continue
		}
		dest := filepath.Join(extractDir, entryRel)
		if dest != extractDir && !strings.HasPrefix(dest, extractDir+string(os.PathSeparator)) {
			http.Error(w, "entry escapes destination: "+raw, http.StatusBadRequest)
			return
		}

		mode := ze.Mode()
		switch {
		case ze.FileInfo().IsDir():
			if err := os.MkdirAll(dest, 0o755); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			dirs++
		case mode&os.ModeSymlink != 0 || !mode.IsRegular():
			http.Error(w, "unsupported entry type: "+raw, http.StatusBadRequest)
			return
		default:
			if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			rc, err := ze.Open()
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			out, err := os.Create(dest)
			if err != nil {
				rc.Close()
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			if _, err := io.Copy(out, rc); err != nil {
				rc.Close()
				out.Close()
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			rc.Close()
			out.Close()
			files++
		}
	}

	relReq := strings.TrimPrefix(r.URL.Query().Get("path"), "/")
	writeJSON(w, map[string]interface{}{
		"path":  filepath.ToSlash(filepath.Join("/", relReq, skillDirName)),
		"dirs":  dirs,
		"files": files,
	})
}

func skillDirNameFromZip(filename string) (string, error) {
	name := filepath.Base(filename)
	if strings.EqualFold(filepath.Ext(name), ".zip") {
		name = strings.TrimSuffix(name, filepath.Ext(name))
	}
	name = filepath.Base(filepath.Clean("/" + name))
	if name == "" || name == "." || name == "/" || strings.ContainsAny(name, `/\`) {
		return "", errors.New("invalid zip filename")
	}
	return name, nil
}

func cleanZipEntry(raw string, skillDirName string) string {
	cleaned := filepath.ToSlash(filepath.Clean("/" + raw))
	if cleaned == "/" {
		return ""
	}
	rel := strings.TrimPrefix(cleaned, "/")
	parts := strings.Split(rel, "/")
	if len(parts) > 1 && parts[0] == skillDirName {
		rel = strings.Join(parts[1:], "/")
	}
	return rel
}

func isMacJunkEntry(rel string) bool {
	for _, part := range strings.Split(filepath.ToSlash(rel), "/") {
		if isMacJunkName(part) {
			return true
		}
	}
	return false
}

func isMacJunkName(name string) bool {
	return name == "__MACOSX" || name == ".DS_Store" || strings.HasPrefix(name, "._")
}

func cleanupMacJunk(dir string) error {
	return filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == dir {
			return nil
		}
		if !isMacJunkName(d.Name()) {
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

func handleDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete && r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	abs, err := resolve(r.URL.Query().Get("path"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if abs == rootAbs {
		http.Error(w, "cannot delete root", http.StatusBadRequest)
		return
	}
	if _, err := os.Lstat(abs); err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := os.RemoveAll(abs); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func handleRename(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	from, err := resolve(r.URL.Query().Get("from"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if from == rootAbs {
		http.Error(w, "cannot rename root", http.StatusBadRequest)
		return
	}
	toName := r.URL.Query().Get("to")
	if toName == "" {
		http.Error(w, "missing 'to'", http.StatusBadRequest)
		return
	}
	cleanedTo := filepath.Base(filepath.Clean("/" + toName))
	if cleanedTo == "" || cleanedTo == "." || cleanedTo == "/" || strings.ContainsAny(cleanedTo, "/\\") {
		http.Error(w, "invalid 'to'", http.StatusBadRequest)
		return
	}
	parent := filepath.Dir(from)
	to := filepath.Join(parent, cleanedTo)
	if to != rootAbs && !strings.HasPrefix(to, rootAbs+string(os.PathSeparator)) {
		http.Error(w, "path escapes root", http.StatusBadRequest)
		return
	}
	if _, err := os.Lstat(from); err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
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
	relParent := strings.TrimPrefix(parent, rootAbs)
	if relParent == "" {
		relParent = "/"
	}
	writeJSON(w, map[string]interface{}{
		"path": filepath.ToSlash(filepath.Join(relParent, cleanedTo)),
		"name": cleanedTo,
	})
}

func handleMkdir(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	parent, err := resolve(r.URL.Query().Get("path"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	info, err := os.Stat(parent)
	if err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if !info.IsDir() {
		http.Error(w, "path is not a directory", http.StatusBadRequest)
		return
	}
	name := r.URL.Query().Get("name")
	cleaned := filepath.Base(filepath.Clean("/" + name))
	if cleaned == "" || cleaned == "." || cleaned == "/" || strings.ContainsAny(name, "/\\") {
		http.Error(w, "invalid 'name'", http.StatusBadRequest)
		return
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	dest := filepath.Join(parent, cleaned)
	if dest != rootAbs && !strings.HasPrefix(dest, rootAbs+string(os.PathSeparator)) {
		http.Error(w, "path escapes root", http.StatusBadRequest)
		return
	}
	if _, err := os.Lstat(dest); err == nil {
		http.Error(w, "destination already exists", http.StatusConflict)
		return
	} else if !os.IsNotExist(err) {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := os.Mkdir(dest, 0o755); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	relParent := strings.TrimPrefix(parent, rootAbs)
	if relParent == "" {
		relParent = "/"
	}
	writeJSON(w, map[string]interface{}{
		"path": filepath.ToSlash(filepath.Join(relParent, cleaned)),
		"name": cleaned,
	})
}

func isBinary(buf []byte) bool {
	if len(buf) == 0 {
		return false
	}
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

func writeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}
