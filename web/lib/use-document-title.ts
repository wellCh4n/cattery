"use client"

// useDocumentTitle — set the browser tab title while a view is mounted, and
// restore the default ("Cattery") on unmount or while no name is available.
//
// Pass the entity's name (harness name / session title). When non-empty the
// tab reads "<name> - Cattery"; otherwise it falls back to the bare app title.

import { useEffect } from "react"

const APP_TITLE = "Cattery"

export function useDocumentTitle(name: string | null | undefined) {
  useEffect(() => {
    const trimmed = name?.trim()
    document.title = trimmed ? `${trimmed} - ${APP_TITLE}` : APP_TITLE
    return () => { document.title = APP_TITLE }
  }, [name])
}
