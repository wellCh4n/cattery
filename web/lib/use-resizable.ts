"use client"

// useResizable — width state + drag handle props for a side panel that lives
// against either the left or the right edge of the screen.
//
// Returns:
//   width: current width in px (clamped to [min, max])
//   handleProps: spread onto the <div> that acts as the drag handle. The
//     handle itself owns no width — caller positions it.
//
// The handle is sized/positioned by the caller. We only track the pointer.

import { useCallback, useEffect, useRef, useState } from "react"

interface Options {
  initial: number
  min: number
  max: number
  storageKey: string
  // "left" — handle is on the LEFT edge of the panel (panel is on screen right
  //          side, e.g. RightRail). Dragging left grows the panel.
  // "right" — handle is on the RIGHT edge of the panel (panel is on screen
  //           left side, e.g. main Sidebar). Dragging right grows the panel.
  side: "left" | "right"
}

export function useResizable({ initial, min, max, storageKey, side }: Options) {
  const [width, setWidth] = useState(initial)
  const dragging = useRef(false)
  // Snapshot starting state on mousedown so deltas don't drift between renders.
  const dragStart = useRef({ x: 0, width: 0 })

  // Hydrate persisted width on mount. Server render uses `initial` to keep
  // SSR markup stable; we adjust client-side after mount. Lazy initial
  // state would mismatch hydration (server has no localStorage), so the
  // setState-in-effect lint rule is suppressed here intentionally.
  useEffect(() => {
    const saved = Number(localStorage.getItem(storageKey))
    if (Number.isFinite(saved) && saved >= min && saved <= max) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setWidth(saved)
    }
  }, [storageKey, min, max])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    dragStart.current = { x: e.clientX, width }
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
  }, [width])

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragging.current) return
      const dx = e.clientX - dragStart.current.x
      // Handle on LEFT edge of a right-anchored panel: leftward drag grows
      //   panel → flip the sign.
      // Handle on RIGHT edge of a left-anchored panel: rightward drag grows
      //   panel → keep the sign.
      const delta = side === "left" ? -dx : dx
      const next = Math.min(max, Math.max(min, dragStart.current.width + delta))
      setWidth(next)
    }
    function onUp() {
      if (!dragging.current) return
      dragging.current = false
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      // Persist final width — skip per-mousemove writes to avoid hammering
      // localStorage during a drag.
      localStorage.setItem(storageKey, String(width))
    }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
    return () => {
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
    }
  }, [width, min, max, side, storageKey])

  return { width, onMouseDown }
}
