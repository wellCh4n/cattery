package config

import (
	"os"

	"github.com/joho/godotenv"
)

type Config struct {
	DatabaseURL      string
	Port             string
	K8sNamespace     string
	AnthropicBaseURL string
	AnthropicAPIKey  string
	OpenAIBaseURL    string
	OpenAIAPIKey     string

	// JWTSecret signs auth tokens. Required; server refuses to start without it.
	JWTSecret string
}

func Load() *Config {
	_ = godotenv.Load(".env", "backend/.env")

	return &Config{
		DatabaseURL:      getEnv("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/cattery?sslmode=disable"),
		Port:             getEnv("PORT", "8080"),
		K8sNamespace:     getEnv("K8S_NAMESPACE", "default"),
		AnthropicBaseURL: getEnv("ANTHROPIC_BASE_URL", ""),
		AnthropicAPIKey:  getEnv("ANTHROPIC_API_KEY", ""),
		OpenAIBaseURL:    getEnv("OPENAI_BASE_URL", ""),
		OpenAIAPIKey:     getEnv("OPENAI_API_KEY", ""),
		JWTSecret:        getEnv("JWT_SECRET", ""),
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
