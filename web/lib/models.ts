"use client"

// The platform's model catalog (backend/models.toml), grouped by provider.
// Sessions can only use these models; the chat's model picker lists them.

import { create } from "zustand"
import { listModels, type ModelCatalog, type ModelProvider } from "@/lib/api"

interface ModelsStore {
  catalog: ModelCatalog | null
  load: () => Promise<ModelCatalog>
}

let inflight: Promise<ModelCatalog> | null = null

export const useModelsStore = create<ModelsStore>((set, get) => ({
  catalog: null,
  // Loaded once per page; the catalog only changes on a backend restart.
  load: () => {
    const cached = get().catalog
    if (cached) return Promise.resolve(cached)
    inflight ??= listModels()
      .then(catalog => {
        set({ catalog })
        return catalog
      })
      .finally(() => { inflight = null })
    return inflight
  },
}))

export function catalogHas(catalog: ModelCatalog, model: string): boolean {
  return catalog.providers.some(p => p.models.includes(model))
}

export function providerOf(catalog: ModelCatalog, model: string): ModelProvider | undefined {
  return catalog.providers.find(p => p.models.includes(model))
}

// The effort model runs at: want when its provider offers it, else the
// provider's default (as the backend resolves it).
export function effortFor(catalog: ModelCatalog, model: string, want: string): string {
  const provider = providerOf(catalog, model)
  if (!provider) return ""
  return provider.efforts.includes(want) ? want : provider.default_effort
}

const EFFORT_LABELS: Record<string, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
}

export function effortLabel(effort: string): string {
  return EFFORT_LABELS[effort] ?? effort
}

const LAST_MODEL_KEY = "cattery:last-model"
const LAST_EFFORT_KEY = "cattery:last-effort"

// The effort last picked in the chat; new sessions start on it when their
// model's provider offers it.
export function readLastEffort(): string {
  if (typeof window === "undefined") return ""
  try {
    return window.localStorage.getItem(LAST_EFFORT_KEY) ?? ""
  } catch {
    return ""
  }
}

export function writeLastEffort(effort: string) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(LAST_EFFORT_KEY, effort)
  } catch {
    // Ignore browser storage failures.
  }
}

// The model last picked in the chat — "+ New session" starts on it. Empty when
// none was picked yet (the backend then uses the catalog default).
export function readLastModel(): string {
  if (typeof window === "undefined") return ""
  try {
    return window.localStorage.getItem(LAST_MODEL_KEY) ?? ""
  } catch {
    return ""
  }
}

export function writeLastModel(model: string) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(LAST_MODEL_KEY, model)
  } catch {
    // Ignore browser storage failures.
  }
}
