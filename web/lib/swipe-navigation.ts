// A horizontal trackpad swipe that nothing scrolls pages browser history, which
// here switches tabs. Used as a ref, this stops that while the pointer is over
// the element. Only the root's overscroll-behavior reliably holds a swipe (a
// wheel listener can cancel just a gesture's first event), so the root carries
// a class while the pointer is inside; elsewhere a swipe still navigates.
export function blockSwipeNavigation(el: HTMLElement | null) {
  if (!el) return
  const root = document.documentElement
  const enter = () => root.classList.add("no-swipe-navigation")
  const leave = () => root.classList.remove("no-swipe-navigation")
  el.addEventListener("pointerenter", enter)
  el.addEventListener("pointerleave", leave)
  return () => {
    el.removeEventListener("pointerenter", enter)
    el.removeEventListener("pointerleave", leave)
    leave()
  }
}
