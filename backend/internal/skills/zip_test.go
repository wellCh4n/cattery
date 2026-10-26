package skills

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"io"
	"sort"
	"strings"
	"testing"
)

func zipOf(t *testing.T, names ...string) *zip.Reader {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, name := range names {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasSuffix(name, "/") {
			_, _ = w.Write([]byte("x"))
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatal(err)
	}
	return zr
}

func tarNames(t *testing.T, r io.Reader) string {
	t.Helper()
	var names []string
	tr := tar.NewReader(r)
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
	return strings.Join(names, ",")
}

func TestSkillZipToTar(t *testing.T) {
	for name, tc := range map[string]struct {
		entries []string
		want    string
	}{
		"folder":     {[]string{"demo/", "demo/SKILL.md", "demo/refs/", "demo/refs/a.md", "__MACOSX/demo/._SKILL.md", "demo/.DS_Store"}, "SKILL.md,refs/,refs/a.md"},
		"flat":       {[]string{"SKILL.md", "refs/a.md"}, "SKILL.md,refs/a.md"},
		"escape":     {[]string{"demo/SKILL.md", "../../etc/x"}, "SKILL.md,etc/x"},
		"no-skill":   {[]string{"demo/README.md"}, ""},
		"nested-man": {[]string{"other/SKILL.md"}, ""},
	} {
		t.Run(name, func(t *testing.T) {
			var buf bytes.Buffer
			err := ZipToTar(zipOf(t, tc.entries...), "demo", &buf)
			if tc.want == "" {
				if err == nil {
					t.Fatal("archive without a top-level SKILL.md accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got := tarNames(t, &buf); got != tc.want {
				t.Fatalf("entries = %s, want %s", got, tc.want)
			}
		})
	}
}

func TestSkillSlugFromZip(t *testing.T) {
	for in, want := range map[string]string{"demo.zip": "demo", "dir/My Skill.ZIP": "My Skill", `C:\x\demo.zip`: "demo", ".zip": "", "..zip": "", ".hidden.zip": ""} {
		got, err := SlugFromZip(in)
		if want == "" {
			if err == nil {
				t.Errorf("%q accepted as %q", in, got)
			}
			continue
		}
		if err != nil || got != want {
			t.Errorf("SlugFromZip(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
}
