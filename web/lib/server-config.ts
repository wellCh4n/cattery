"use client"

import { useEffect } from "react"
import { getServerConfig } from "@/lib/api"
import { createResourceStore } from "@/lib/resource-store"

const useServerConfigStore = createResourceStore(() => getServerConfig())

// usePreviewTemplate is the preview host template, undefined until the
// backend answers, or null if it couldn't be loaded (previews can't open).
export function usePreviewTemplate(): string | null | undefined {
  const entry = useServerConfigStore(state => state.entries.config)
  useEffect(() => { void useServerConfigStore.getState().load("config") }, [])
  if (entry?.data) return entry.data.preview_url
  return entry?.error ? null : undefined
}
