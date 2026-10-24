"use client"

import { useEffect, useState } from "react"
import { CircleCheck, Info, Loader2, OctagonX, TriangleAlert } from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { buttonVariants } from "@/components/ui/button"

// The theme lives in the <html> "dark" class (lib/theme.ts), not next-themes,
// so the toaster follows that class.
function useDocumentTheme(): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">("light")
  useEffect(() => {
    const root = document.documentElement
    const read = () => setTheme(root.classList.contains("dark") ? "dark" : "light")
    read()
    const observer = new MutationObserver(read)
    observer.observe(root, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])
  return theme
}

// Toasts are unstyled Sonner (it keeps stacking, swiping and animation) drawn
// like the app's popovers: its own CSS would set a system sans font, padding
// and buttons of its own.
export function Toaster(props: ToasterProps) {
  const theme = useDocumentTheme()
  return (
    <Sonner
      theme={theme}
      className="toaster group"
      icons={{
        success: <CircleCheck className="size-4" />,
        info: <Info className="size-4" />,
        warning: <TriangleAlert className="size-4" />,
        error: <OctagonX className="size-4" />,
        loading: <Loader2 className="size-4 animate-spin" />,
      }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: "flex w-(--width) items-center gap-2.5 rounded-lg bg-popover p-2.5 font-sans text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10",
          icon: "flex size-4 shrink-0 items-center justify-center text-muted-foreground",
          content: "flex min-w-0 flex-1 flex-col gap-0.5",
          title: "truncate font-medium",
          description: "truncate text-xs text-muted-foreground",
          actionButton: buttonVariants({ variant: "outline", size: "sm" }),
          cancelButton: buttonVariants({ variant: "ghost", size: "sm" }),
        },
      }}
      {...props}
    />
  )
}
