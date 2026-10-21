package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

var latexSlot = make(chan struct{}, 1)
var latexMu sync.RWMutex

type latexState struct {
	PDF          string            `json:"pdf,omitempty"`
	Version      string            `json:"version,omitempty"`
	Stale        bool              `json:"stale"`
	Dependencies map[string]string `json:"dependencies,omitempty"`
}

func fileDigest(path string) string {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return ""
	}
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return ""
	}
	return fmt.Sprintf("%x", h.Sum(nil))
}

func latexPaths(path string) (string, string, error) {
	abs, err := resolve(path)
	if err != nil {
		return "", "", err
	}
	abs, err = filepath.EvalSymlinks(abs)
	if err != nil {
		return "", "", err
	}
	base, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", "", err
	}
	if !strings.HasPrefix(abs, base+string(os.PathSeparator)) || strings.ToLower(filepath.Ext(abs)) != ".tex" {
		return "", "", fmt.Errorf("expected a .tex file inside the workspace")
	}
	info, err := os.Stat(abs)
	if err != nil || !info.Mode().IsRegular() {
		return "", "", fmt.Errorf("expected a regular .tex file")
	}
	cache := filepath.Join(base, ".cattery", "latex", fmt.Sprintf("%x", sha256.Sum256([]byte(abs))))
	// Never follow workspace-controlled cache symlinks.
	for p := cache; p != base; p = filepath.Dir(p) {
		if fi, e := os.Lstat(p); e == nil && (fi.Mode()&os.ModeSymlink != 0 || !fi.IsDir()) {
			return "", "", fmt.Errorf("invalid preview cache directory")
		}
	}
	return abs, cache, nil
}

func readLatexState(abs, cache string) latexState {
	latexMu.RLock()
	defer latexMu.RUnlock()
	var state latexState
	b, err := os.ReadFile(filepath.Join(cache, "state.json"))
	if err == nil && json.Unmarshal(b, &state) == nil {
		if _, err := os.Stat(filepath.Join(cache, "preview.pdf")); err == nil {
			for path, hash := range state.Dependencies {
				if fileDigest(path) != hash {
					state.Stale = true
				}
			}
			return state
		}
	}
	// An existing sibling PDF is useful even before the first manual compile.
	pdf := strings.TrimSuffix(abs, filepath.Ext(abs)) + ".pdf"
	if info, err := os.Stat(pdf); err == nil && info.Mode().IsRegular() {
		rel, _ := filepath.Rel(root, pdf)
		state = latexState{PDF: "/" + filepath.ToSlash(rel), Version: fmt.Sprint(info.ModTime().UnixNano()), Stale: true}
	}
	return state
}

func handleLatex(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		http.Error(w, "method not allowed", 405)
		return
	}
	abs, cache, err := latexPaths(r.URL.Query().Get("path"))
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if r.Method == http.MethodGet {
		writeJSON(w, readLatexState(abs, cache))
		return
	}
	select {
	case latexSlot <- struct{}{}:
		defer func() { <-latexSlot }()
	default:
		http.Error(w, "Another document is compiling. Try again shortly.", 409)
		return
	}
	if _, err := exec.LookPath("xelatex"); err != nil {
		http.Error(w, "LaTeX compiler is unavailable. Rebuild the filemgr image.", 503)
		return
	}
	if err := os.MkdirAll(cache, 0755); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	temp, err := os.MkdirTemp(cache, "build-")
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer os.RemoveAll(temp)
	started := time.Now()
	sourceHash := fileDigest(abs)
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	var output limitedLog
	// Two passes resolve document cross-references. No shell or project rc files.
	for i := 0; i < 2; i++ {
		cmd := exec.CommandContext(ctx, "xelatex", "-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "-recorder", "-jobname=preview", "-output-directory="+temp, "./"+filepath.Base(abs))
		cmd.Dir = filepath.Dir(abs)
		cmd.Env = append(os.Environ(), "openin_any=p", "openout_any=p", "TEXMFOUTPUT="+temp)
		cmd.Stdout, cmd.Stderr = &output, &output
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
		cmd.WaitDelay = time.Second
		if err := cmd.Run(); err != nil {
			message := "Compilation failed. The previous preview is preserved.\n" + string(output)
			if ctx.Err() != nil {
				message = "Compilation cancelled or exceeded the 60 second limit. The previous preview is preserved."
			}
			http.Error(w, message, 422)
			return
		}
	}
	state := latexState{Dependencies: map[string]string{abs: sourceHash}, Version: fmt.Sprint(time.Now().UnixNano())}
	recorder, err := os.ReadFile(filepath.Join(temp, "preview.fls"))
	if err != nil {
		http.Error(w, "Compiler did not produce dependency information", 500)
		return
	}
	for _, line := range strings.Split(string(recorder), "\n") {
		if !strings.HasPrefix(line, "INPUT ") {
			continue
		}
		path := strings.TrimPrefix(line, "INPUT ")
		if !filepath.IsAbs(path) {
			path = filepath.Join(filepath.Dir(abs), path)
		}
		path = filepath.Clean(path)
		if !strings.HasPrefix(path, root+string(os.PathSeparator)) || strings.HasPrefix(path, cache+string(os.PathSeparator)) {
			continue
		}
		if path != abs {
			state.Dependencies[path] = fileDigest(path)
		}
		if info, err := os.Stat(path); err != nil || info.ModTime().After(started) {
			state.Stale = true
		}
	}
	if fileDigest(abs) != sourceHash {
		state.Stale = true
	}
	rel, _ := filepath.Rel(root, filepath.Join(cache, "preview.pdf"))
	state.PDF = "/" + filepath.ToSlash(rel)
	b, _ := json.Marshal(state)
	latexMu.Lock()
	err = os.WriteFile(filepath.Join(temp, "state.json"), b, 0644)
	if err == nil {
		err = os.Rename(filepath.Join(temp, "preview.pdf"), filepath.Join(cache, "preview.pdf"))
	}
	if err == nil {
		err = os.Rename(filepath.Join(temp, "state.json"), filepath.Join(cache, "state.json"))
	}
	latexMu.Unlock()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, state)
}

// Keep only the final 16 KiB of compiler diagnostics.
type limitedLog []byte

func (b *limitedLog) Write(p []byte) (int, error) {
	n := len(p)
	*b = append(*b, p...)
	if len(*b) > 16384 {
		*b = (*b)[len(*b)-16384:]
	}
	return n, nil
}
