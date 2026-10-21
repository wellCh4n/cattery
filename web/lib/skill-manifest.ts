// Standard SKILL.md frontmatter fields: the Agent Skills specification
// (https://agentskills.io/specification) plus pi's `disable-model-invocation`.

export type SkillField = {
  key: string
  label: string
  hint: string
  required?: boolean
  experimental?: boolean
}

export const SKILL_FIELDS: SkillField[] = [
  { key: "name", label: "Name", hint: "Command and display name", required: true },
  { key: "description", label: "Description", hint: "What the skill does and when to use it; shown to the model for routing", required: true },
  { key: "license", label: "License", hint: "License name or bundled license file" },
  { key: "compatibility", label: "Compatibility", hint: "Environment requirements: intended product, system packages, network access" },
  { key: "allowed-tools", label: "Allowed tools", hint: "Space-separated tools pre-approved to run", experimental: true },
  { key: "disable-model-invocation", label: "Model invocation", hint: "When true, the skill is hidden from automatic model selection and only runs via /skill:name" },
  { key: "metadata", label: "Metadata", hint: "Additional string key-value properties" },
]

export const SKILL_FIELD_KEYS = new Set(SKILL_FIELDS.map(field => field.key))

const MAX_NAME_LENGTH = 64
const MAX_DESCRIPTION_LENGTH = 1024
const MAX_COMPATIBILITY_LENGTH = 500

// validateSkillManifest checks frontmatter against the spec's constraints.
// `dirName` is the skill's folder, which the spec requires `name` to match.
export function validateSkillManifest(data: Record<string, unknown>, dirName?: string): string[] {
  const issues: string[] = []
  const { name, description, license, compatibility, metadata } = data
  const allowedTools = data["allowed-tools"]
  const disableModelInvocation = data["disable-model-invocation"]

  if (name == null || name === "") {
    issues.push("name is required")
  } else if (typeof name !== "string") {
    issues.push("name must be a string")
  } else {
    if (name.length > MAX_NAME_LENGTH) issues.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`)
    if (!/^[a-z0-9-]+$/.test(name)) issues.push("name may only contain lowercase a-z, 0-9 and hyphens")
    if (name.startsWith("-") || name.endsWith("-")) issues.push("name must not start or end with a hyphen")
    if (name.includes("--")) issues.push("name must not contain consecutive hyphens")
    if (dirName && name !== dirName) issues.push(`name should match the skill folder "${dirName}"`)
  }

  if (typeof description !== "string" || description.trim() === "") {
    issues.push("description is required")
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    issues.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`)
  }

  if (license != null && typeof license !== "string") issues.push("license must be a string")

  if (compatibility != null) {
    if (typeof compatibility !== "string" || compatibility.trim() === "") {
      issues.push("compatibility must be a non-empty string")
    } else if (compatibility.length > MAX_COMPATIBILITY_LENGTH) {
      issues.push(`compatibility exceeds ${MAX_COMPATIBILITY_LENGTH} characters (${compatibility.length})`)
    }
  }

  if (allowedTools != null && typeof allowedTools !== "string") {
    issues.push("allowed-tools should be a space-separated string")
  }

  if (disableModelInvocation != null && typeof disableModelInvocation !== "boolean") {
    issues.push("disable-model-invocation must be true or false")
  }

  if (metadata != null) {
    if (typeof metadata !== "object" || Array.isArray(metadata)) {
      issues.push("metadata must be a key-value mapping")
    } else {
      const nonString = Object.entries(metadata).filter(([, v]) => typeof v !== "string").map(([k]) => k)
      if (nonString.length > 0) issues.push(`metadata values should be strings (${nonString.join(", ")})`)
    }
  }

  return issues
}
