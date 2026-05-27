"use client"

import { useState } from "react"
import { Info } from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { HarnessInfoPanel } from "@/components/harness-info-panel"
import type { Harness, Session } from "@/lib/api"

export function HarnessInfoButton({ harness, session }: { harness: Harness; session: Session }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Harness info"
        aria-label="Harness info"
        className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Info className="size-3.5" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          className="w-[calc(100%-2rem)] sm:max-w-md h-[80vh] p-0 gap-0 overflow-hidden flex flex-col"
        >
          <DialogTitle className="sr-only">Harness info</DialogTitle>
          <HarnessInfoPanel harness={harness} session={session} />
        </DialogContent>
      </Dialog>
    </>
  )
}
