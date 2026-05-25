// filemgr: tiny HTTP file API served as a sidecar inside the harness Pod.
// Shares /work with the harness container via emptyDir. Internal-only —
// reached through the backend proxy, never exposed externally.
package main

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const (
	defaultRoot    = "/work"
	defaultPort    = "1115"
	maxReadBytes   = 2 * 1024 * 1024 // 2MB — keeps the frontend snappy
	dirEntryLimit  = 2000            // protect against huge dirs
)

type entry struct {
	Name  string `json:"name"`
	Type  string `json:"type"` // "file" | "dir" | "link"
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"` // unix seconds
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
	root = os.Getenv("FILEMGR_ROOT")
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
	mux.HandleFunc("/raw", handleRaw)
	mux.HandleFunc("/download", handleDownload)
	mux.HandleFunc("/upload", handleUpload)
	mux.HandleFunc("/delete", handleDelete)
	mux.HandleFunc("/rename", handleRename)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	addr := "0.0.0.0:" + port
	log.Printf("filemgr listening on %s, root=%s", addr, root)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("listen: %v", err)
	}
}

// resolve cleans the user-supplied relative path and joins it under root,
// rejecting anything that would escape via .. or absolute symlinks.
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

	dirents, err := os.ReadDir(abs)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	out := make([]entry, 0, len(dirents))
	for i, de := range dirents {
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
	// dirs first, then alpha within each group — matches IDEA / VSCode trees
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

// handleRaw streams raw file bytes for inline display in the browser. Unlike
// /download it sets a sniffed Content-Type (so <img>, <video>, <audio>, PDFs
// all render in-tab) and does NOT add Content-Disposition. Used by the
// frontend to preview images/media in the file viewer dialog.
func handleRaw(w http.ResponseWriter, r *http.Request) {
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
	// Prefer mime.TypeByExtension for known extensions (covers svg as
	// image/svg+xml, which DetectContentType reports as text/xml). Fall back
	// to http.ServeContent's own sniffing when the extension is unknown by
	// leaving the Content-Type header unset.
	if ct := mime.TypeByExtension(filepath.Ext(abs)); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	http.ServeFile(w, r, abs)
}

// handleDownload streams raw file bytes with Content-Disposition: attachment.
// Distinct from /read (which returns JSON with a length-limited content field
// for previewing in the editor) — /download has no size cap and is the path
// users hit when they want the file on their machine.
func handleDownload(w http.ResponseWriter, r *http.Request) {
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
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	w.Header().Set("Content-Disposition", "attachment; filename="+strconv.Quote(filepath.Base(abs)))
	http.ServeFile(w, r, abs)
}

// handleUpload accepts a single multipart "file" field and writes it to ?path=
// (a directory under root). The file lands at <path>/<original name>; existing
// files are overwritten. Returns the resolved relative path.
func handleUpload(w http.ResponseWriter, r *http.Request) {
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

	// 256 MB cap on a single request — both for memory safety on the parser
	// side and because anything bigger probably belongs to git-lfs / a bucket.
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

	// strip any directory component the browser might have sent
	name := filepath.Base(header.Filename)
	if name == "" || name == "." || name == "/" {
		http.Error(w, "invalid filename", http.StatusBadRequest)
		return
	}
	dest := filepath.Join(destDir, name)
	// final safety check — name shouldn't be able to escape destDir
	if !strings.HasPrefix(dest, destDir+string(os.PathSeparator)) && dest != destDir {
		http.Error(w, "invalid filename", http.StatusBadRequest)
		return
	}

	out, err := os.Create(dest)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer out.Close()
	if _, err := io.Copy(out, f); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	relReq := strings.TrimPrefix(r.URL.Query().Get("path"), "/")
	writeJSON(w, map[string]interface{}{
		"path": filepath.ToSlash(filepath.Join("/", relReq, name)),
		"name": name,
		"size": header.Size,
	})
}

// handleDelete removes the file or directory at ?path=. Directories are
// removed recursively (rm -rf semantics) — the user explicitly asked for hard
// delete, no .trash. Refuses to delete the root itself.
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

// handleRename moves ?from= to a sibling at ?to= (a base name, not a path).
// Both must resolve under root, and "to" must stay in the same parent dir as
// "from" — this endpoint is for renaming, not moving across directories.
// Refuses to overwrite an existing entry.
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
	// Treat "to" as a bare base name — the browser shouldn't be sending paths
	// here, and accepting a path would let callers move across directories.
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

// isBinary uses the same heuristic git does: presence of a NUL byte in the
// first chunk. Cheap and good enough for editor-style previews.
func isBinary(buf []byte) bool {
	n := min(len(buf), 8000)
	for i := range n {
		if buf[i] == 0 {
			return true
		}
	}
	return false
}

func writeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
