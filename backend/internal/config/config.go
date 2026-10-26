package config

import (
	"os"

	"github.com/joho/godotenv"
)

type Config struct {
	DatabaseURL  string
	Port         string
	K8sNamespace string
	// ModelsConfig is the path of the model catalog (see models.example.toml).
	ModelsConfig string

	// K8sStorageClass is the storageClassName stamped on every PVC. Empty means
	// "use the cluster's default StorageClass" (current/legacy behavior).
	K8sStorageClass string
	// K8sPVCAccessMode is the access mode for every PVC. Defaults to
	// ReadWriteMany. Set to ReadWriteOnce when the chosen StorageClass is
	// block-backed (most single-SC clusters): each workspace PVC is mounted by
	// its project's Pod only.
	K8sPVCAccessMode string

	// JWTSecret signs auth tokens. Required; server refuses to start without it.
	JWTSecret string

	// PreviewURL names each app preview's own host: a URL with a wildcard
	// host. Defaults to http://*.localhost:<PORT>, which browsers resolve to
	// this machine; production sets e.g. https://*.preview.example.com, with
	// wildcard DNS and TLS pointing at the backend.
	PreviewURL string

	// PiImage is the image of every project Pod. Defaults to the local :dev
	// tag `make build-harness` builds; deployments point it at a registry.
	PiImage string

	// SkillsDir holds the global skill library, one `<slug>/SKILL.md` folder
	// per skill. Relative paths resolve against the working directory, so
	// `make dev` keeps it in backend/data/skills; deployments mount a volume.
	SkillsDir string
}

func Load() *Config {
	_ = godotenv.Load(".env", "backend/.env")

	port := getEnv("PORT", "8080")
	return &Config{
		DatabaseURL:      getEnv("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/cattery?sslmode=disable"),
		Port:             port,
		K8sNamespace:     getEnv("K8S_NAMESPACE", "default"),
		ModelsConfig:     getEnv("MODELS_CONFIG", "models.toml"),
		JWTSecret:        getEnv("JWT_SECRET", ""),
		K8sStorageClass:  getEnv("K8S_STORAGE_CLASS", ""),
		K8sPVCAccessMode: getEnv("K8S_PVC_ACCESS_MODE", "ReadWriteMany"),
		PreviewURL:       getEnv("PREVIEW_URL", "http://*.localhost:"+port),
		PiImage:          getEnv("PI_IMAGE", "cattery-pi:dev"),
		SkillsDir:        getEnv("SKILLS_DIR", "data/skills"),
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
