package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeConfig(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "models.toml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadModels(t *testing.T) {
	m, err := LoadModels(writeConfig(t, `
[[providers]]
name     = "DeepSeek"
type     = "deepseek"
endpoint = "https://api.deepseek.com/"
key      = "sk-test"
models   = ["deepseek-flash", " deepseek-v4-pro "]
`))
	if err != nil {
		t.Fatal(err)
	}
	if m.Default != "deepseek-flash" {
		t.Errorf("Default = %q, want first model", m.Default)
	}
	got, ok := m.Get("deepseek-v4-pro")
	if !ok {
		t.Fatal("Get(deepseek-v4-pro) not found")
	}
	if got.Provider.Type != "deepseek" || got.Provider.Endpoint != "https://api.deepseek.com" || got.Provider.Key != "sk-test" {
		t.Errorf("Get(deepseek-v4-pro).Provider = %+v", got.Provider)
	}
	if _, ok := m.Get("gpt-5.5"); ok {
		t.Error("Get(gpt-5.5) found an unconfigured model")
	}
}

func TestLoadModelsRejects(t *testing.T) {
	const provider = `
[[providers]]
name     = "DeepSeek"
type     = "deepseek"
endpoint = "https://api.deepseek.com"
key      = "sk-test"
models   = ["deepseek-flash"]
`
	tests := []struct {
		name, body, want string
	}{
		{"no providers", ``, "no providers"},
		{"unknown type", strings.Replace(provider, `"deepseek"`, `"gemini"`, 1), "type must be"},
		{"missing key", strings.Replace(provider, `key      = "sk-test"`, ``, 1), "key is required"},
		{"unknown default", `default = "gpt-5.5"` + provider, "default model"},
		{"duplicate model", provider + strings.Replace(provider, `"DeepSeek"`, `"Mirror"`, 1), "more than once"},
		{"typo'd key", strings.Replace(provider, "endpoint", "endpiont", 1), "unknown keys"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := LoadModels(writeConfig(t, tt.body))
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("err = %v, want it to mention %q", err, tt.want)
			}
		})
	}
}
