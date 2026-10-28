package api

import "testing"

func TestTouchesSkills(t *testing.T) {
	for p, want := range map[string]bool{
		"":                         false,
		"/":                        true,
		"/.agents":                 true,
		".agents/skills":           true,
		"/.agents/skills/pdf":      true,
		"/.agents/skills/pdf/a.md": true,
		"/.agents/skills-old":      false,
		"/.agents/other":           false,
		"/src":                     false,
		"/src/../.agents/skills/x": true,
	} {
		if got := touchesSkills(p); got != want {
			t.Errorf("touchesSkills(%q) = %v, want %v", p, got, want)
		}
	}
}
