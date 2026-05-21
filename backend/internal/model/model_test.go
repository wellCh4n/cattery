package model

import "testing"

func TestProviderForModelConfiguredModels(t *testing.T) {
	tests := []struct {
		name    string
		modelID string
		want    string
	}{
		{name: "claude sonnet uses anthropic", modelID: "claude-sonnet-4-6", want: ProviderAnthropic},
		{name: "claude opus uses anthropic", modelID: "claude-opus-4-7", want: ProviderAnthropic},
		{name: "gpt uses openai", modelID: "gpt-5.5", want: ProviderOpenAI},
		{name: "normalizes whitespace and case", modelID: "  GPT-5.4  ", want: ProviderOpenAI},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := ProviderForModel(tt.modelID)
			if !ok {
				t.Fatalf("ProviderForModel(%q) ok = false, want true", tt.modelID)
			}
			if got != tt.want {
				t.Fatalf("ProviderForModel(%q) = %q, want %q", tt.modelID, got, tt.want)
			}
		})
	}
}

func TestProviderForModelUnknown(t *testing.T) {
	if got, ok := ProviderForModel("custom-model"); ok || got != ProviderOpenAI {
		t.Fatalf("ProviderForModel custom = (%q, %v), want (%q, false)", got, ok, ProviderOpenAI)
	}
}
