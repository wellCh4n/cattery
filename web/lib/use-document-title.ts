"use client"

// useDocumentTitle — set the browser tab title while a view is mounted, and
// restore the default ("Cattery") on unmount or while no name is available.
//
// Pass the entity's name (session title). When non-empty the
// tab reads "<name> - Cattery"; otherwise it falls back to the bare app title.
//
// Next re-renders the root layout's metadata <title> after a client-side
// navigation, after this view's effects have run, so a title set once would be
// overwritten. Re-apply it whenever <head>'s title changes away from it.

import { useEffect } from "react"

const APP_TITLE = "Cattery"

export function useDocumentTitle(name: string | null | undefined) {
  useEffect(() => {
    const trimmed = name?.trim()
    const title = trimmed ? `${trimmed} - ${APP_TITLE}` : APP_TITLE
    document.title = title
    const observer = new MutationObserver(() => {
      if (document.title !== title) document.title = title
    })
    observer.observe(document.head, { subtree: true, childList: true, characterData: true })
    return () => {
      observer.disconnect()
      document.title = APP_TITLE
    }
  }, [name])
}
