package config

import (
	"os"
)

type Config struct {
	DatabaseURL  string
	Port         string
	K8sNamespace string
	ModelAPIBase string
	ModelAPIKey  string
	ModelAPIStyle string // "openai" or "anthropic"
}

func Load() *Config {
	return &Config{
		DatabaseURL:   getEnv("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/cattery?sslmode=disable"),
		Port:          getEnv("PORT", "8080"),
		K8sNamespace:  getEnv("K8S_NAMESPACE", "default"),
		ModelAPIBase:  getEnv("MODEL_API_BASE", ""),
		ModelAPIKey:   getEnv("MODEL_API_KEY", ""),
		ModelAPIStyle: getEnv("MODEL_API_STYLE", "openai"),
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
