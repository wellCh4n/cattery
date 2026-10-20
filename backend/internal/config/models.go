package config

import (
	"fmt"
	"strings"

	"github.com/BurntSushi/toml"
)

// Provider types are pi-ai provider ids. A built-in one makes the agent reuse
// pi's catalog entry for each model (context window, thinking levels, provider
// quirks such as DeepSeek's reasoning_content replay) and only swap in the
// configured endpoint. ProviderCustom is any other OpenAI-compatible endpoint,
// spoken to as plain chat completions.
const (
	ProviderAnthropic = "anthropic"
	ProviderDeepSeek  = "deepseek"
	ProviderOpenAI    = "openai"
	ProviderCustom    = "custom"
)

var knownProviders = map[string]bool{
	ProviderAnthropic: true,
	ProviderDeepSeek:  true,
	ProviderOpenAI:    true,
	ProviderCustom:    true,
}

// Provider is one model provider in the catalog: an endpoint, its key, and the
// models users may pick from it.
type Provider struct {
	// Name is the label shown in the UI, e.g. "DeepSeek".
	Name     string   `toml:"name"`
	Type     string   `toml:"type"`
	Endpoint string   `toml:"endpoint"`
	Key      string   `toml:"key"`
	Models   []string `toml:"models"`
}

// Models is the platform's model catalog, loaded from MODELS_CONFIG. Sessions
// can only use models listed here; model ids are unique across providers.
type Models struct {
	// Default is the model new sessions start on; empty means the first one.
	Default   string     `toml:"default"`
	Providers []Provider `toml:"providers"`
}

// Model is a selectable model resolved to the provider that serves it.
type Model struct {
	ID       string
	Provider *Provider
}

// LoadModels reads and validates the model catalog at path.
func LoadModels(path string) (*Models, error) {
	var m Models
	md, err := toml.DecodeFile(path, &m)
	if err != nil {
		return nil, fmt.Errorf("model config: %w", err)
	}
	if undecoded := md.Undecoded(); len(undecoded) > 0 {
		return nil, fmt.Errorf("model config %s: unknown keys %v", path, undecoded)
	}
	if err := m.validate(); err != nil {
		return nil, fmt.Errorf("model config %s: %w", path, err)
	}
	return &m, nil
}

func (m *Models) validate() error {
	seen := map[string]bool{}
	for i := range m.Providers {
		p := &m.Providers[i]
		p.Endpoint = strings.TrimRight(strings.TrimSpace(p.Endpoint), "/")
		label := p.Name
		if label == "" {
			label = fmt.Sprintf("providers[%d]", i)
		}
		switch {
		case p.Name == "":
			return fmt.Errorf("%s: name is required", label)
		case !knownProviders[p.Type]:
			return fmt.Errorf("provider %q: type must be one of anthropic, deepseek, openai, custom", label)
		case p.Endpoint == "":
			return fmt.Errorf("provider %q: endpoint is required", label)
		case p.Key == "":
			return fmt.Errorf("provider %q: key is required", label)
		case len(p.Models) == 0:
			return fmt.Errorf("provider %q: models is empty", label)
		}
		for j, id := range p.Models {
			id = strings.TrimSpace(id)
			switch {
			case id == "":
				return fmt.Errorf("provider %q: models[%d] is empty", label, j)
			case seen[id]:
				return fmt.Errorf("provider %q: model %q is listed more than once", label, id)
			}
			p.Models[j] = id
			seen[id] = true
		}
	}
	if len(seen) == 0 {
		return fmt.Errorf("no providers configured")
	}
	if m.Default == "" {
		m.Default = m.Providers[0].Models[0]
	} else if !seen[m.Default] {
		return fmt.Errorf("default model %q is not offered by any provider", m.Default)
	}
	return nil
}

// Get returns the configured model with the given id.
func (m *Models) Get(id string) (Model, bool) {
	for i := range m.Providers {
		for _, mid := range m.Providers[i].Models {
			if mid == id {
				return Model{ID: id, Provider: &m.Providers[i]}, true
			}
		}
	}
	return Model{}, false
}
