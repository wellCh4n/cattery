"use client"

// The platform's model catalog (backend/models.toml), grouped by provider.
// Sessions can only use these models; the chat's model picker lists them.

import { create } from "zustand"
import { listModels, type ModelCatalog } from "@/lib/api"

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

const LAST_MODEL_KEY = "cattery:last-model"

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
