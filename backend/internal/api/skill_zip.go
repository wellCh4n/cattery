package api

import (
	"archive/tar"
	"archive/zip"
	"errors"
	"io"
	"path"
	"path/filepath"
	"strings"
)

// A skill archive is a `<slug>.zip` holding the skill folder: either
// `<slug>/SKILL.md (+assets)` or the folder's contents at the top level.
// These helpers mirror skillmgr's upload rules for uploads that go straight
// into a project.

// skillSlugFromZip names the skill after the archive, without `.zip`.
func skillSlugFromZip(filename string) (string, error) {
	name := filepath.Base(strings.ReplaceAll(filename, `\`, "/"))
	if strings.EqualFold(path.Ext(name), ".zip") {
		name = strings.TrimSuffix(name, path.Ext(name))
	}
	if name == "" || name == "." || name == ".." || strings.HasPrefix(name, ".") || strings.ContainsAny(name, `/\`) {
		return "", errors.New("invalid zip filename")
	}
	return name, nil
}

// skillZipEntry returns an entry's path inside the skill folder, dropping the
// archive's own top-level `<slug>/` folder; "" means the folder itself.
func skillZipEntry(raw, slug string) string {
	rel := strings.TrimPrefix(path.Clean("/"+raw), "/")
	if rel == "" {
		return ""
	}
	parts := strings.Split(rel, "/")
	if parts[0] == slug {
		parts = parts[1:]
	}
	return strings.Join(parts, "/")
}

func isMacJunkPath(rel string) bool {
	for _, part := range strings.Split(rel, "/") {
		if part == "__MACOSX" || part == ".DS_Store" || strings.HasPrefix(part, "._") {
			return true
		}
	}
	return false
}

// skillZipToTar rewrites a skill archive as a tar of the skill folder's
// contents (the agent's /extract format). It requires a SKILL.md at the top and
// refuses symlinks and other special entries.
func skillZipToTar(zr *zip.Reader, slug string, w io.Writer) error {
	type entry struct {
		rel  string
		file *zip.File
	}
	var entries []entry
	manifest := false
	for _, f := range zr.File {
		if f.Name == "" || strings.HasPrefix(f.Name, "/") || strings.Contains(f.Name, `\`) {
			return errors.New("invalid entry path: " + f.Name)
		}
		rel := skillZipEntry(f.Name, slug)
		if rel == "" || isMacJunkPath(rel) {
			continue
		}
		mode := f.Mode()
		if !mode.IsDir() && !mode.IsRegular() {
			return errors.New("unsupported entry type: " + f.Name)
		}
		if rel == "SKILL.md" && mode.IsRegular() {
			manifest = true
		}
		entries = append(entries, entry{rel, f})
	}
	if !manifest {
		return errors.New("not a skill: the archive needs a SKILL.md in its top folder")
	}

	tw := tar.NewWriter(w)
	for _, e := range entries {
		if e.file.Mode().IsDir() {
			if err := tw.WriteHeader(&tar.Header{Name: e.rel + "/", Typeflag: tar.TypeDir, Mode: 0o755, ModTime: e.file.Modified}); err != nil {
				return err
			}
			continue
		}
		hdr := &tar.Header{Name: e.rel, Typeflag: tar.TypeReg, Mode: int64(e.file.Mode().Perm()), Size: int64(e.file.UncompressedSize64), ModTime: e.file.Modified}
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		rc, err := e.file.Open()
		if err != nil {
			return err
		}
		_, err = io.Copy(tw, rc)
		rc.Close()
		if err != nil {
			return err
		}
	}
	return tw.Close()
}
