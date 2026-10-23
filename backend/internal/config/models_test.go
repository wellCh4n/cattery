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
	if m.SmallModel != m.Default {
		t.Fatalf("SmallModel = %q, want default %q", m.SmallModel, m.Default)
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
	if e := got.Provider.Efforts; strings.Join(e, ",") != "low,medium,high" {
		t.Errorf("default Efforts = %v, want low,medium,high", e)
	}
	if d := got.Provider.DefaultEffort(); d != "high" {
		t.Errorf("DefaultEffort = %q, want high", d)
	}
}

func TestProviderEfforts(t *testing.T) {
	m, err := LoadModels(writeConfig(t, `
[[providers]]
name     = "DeepSeek"
type     = "deepseek"
endpoint = "https://api.deepseek.com"
key      = "sk-test"
models   = ["deepseek-flash"]
efforts  = ["low", "high", "max"]

[[providers]]
name     = "Other"
type     = "custom"
endpoint = "https://example.com/v1"
key      = "sk-test"
models   = ["other"]
efforts  = ["minimal", "low"]
`))
	if err != nil {
		t.Fatal(err)
	}
	ds, _ := m.Get("deepseek-flash")
	if !ds.Provider.HasEffort("max") || ds.Provider.HasEffort("medium") {
		t.Errorf("DeepSeek efforts = %v", ds.Provider.Efforts)
	}
	if d := ds.Provider.DefaultEffort(); d != "high" {
		t.Errorf("DeepSeek DefaultEffort = %q, want high", d)
	}
	other, _ := m.Get("other")
	if d := other.Provider.DefaultEffort(); d != "low" {
		t.Errorf("Other DefaultEffort = %q, want the highest offered (low)", d)
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
		{"unknown small model", `small_model = "missing"` + provider, "small_model"},
		{"unknown default", `default = "gpt-5.5"` + provider, "default model"},
		{"duplicate model", provider + strings.Replace(provider, `"DeepSeek"`, `"Mirror"`, 1), "more than once"},
		{"typo'd key", strings.Replace(provider, "endpoint", "endpiont", 1), "unknown keys"},
		{"unknown effort", provider + `efforts = ["low", "turbo"]`, "effort \"turbo\""},
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

func TestSmallModelReference(t *testing.T) {
	m, err := LoadModels(writeConfig(t, `
default = "main"
small_model = "small"
[[providers]]
name = "Main"
type = "openai"
endpoint = "https://main.example/v1"
key = "main-key"
models = ["main"]
[[providers]]
name = "Lightweight"
type = "custom"
endpoint = "https://small.example/v1"
key = "small-key"
models = ["small"]
`))
	if err != nil {
		t.Fatal(err)
	}
	small, ok := m.Get(m.SmallModel)
	if !ok || small.ID != "small" || small.Provider.Key != "small-key" || small.Provider.Endpoint != "https://small.example/v1" {
		t.Fatal("small_model did not resolve to its own provider")
	}
}

func TestProviderAPI(t *testing.T) {
	m, err := LoadModels(writeConfig(t, `
[[providers]]
name     = "DeepSeek"
type     = "deepseek"
api      = "openai-responses"
endpoint = "https://api.deepseek.com"
key      = "sk-test"
models   = ["deepseek-flash"]
`))
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := m.Get("deepseek-flash"); got.Provider.API != "openai-responses" {
		t.Errorf("API = %q, want openai-responses", got.Provider.API)
	}
	_, err = LoadModels(writeConfig(t, `
[[providers]]
name     = "DeepSeek"
type     = "deepseek"
api      = "grpc"
endpoint = "https://api.deepseek.com"
key      = "sk-test"
models   = ["deepseek-flash"]
`))
	if err == nil || !strings.Contains(err.Error(), "api must be one of") {
		t.Fatalf("unknown api: err = %v", err)
	}
}
