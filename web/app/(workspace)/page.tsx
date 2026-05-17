import { MessagesSquare } from "lucide-react"

export default function EmptyPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center px-6">
      <div className="rounded-full bg-muted p-4 mb-4">
        <MessagesSquare className="size-7 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium">No session selected</p>
      <p className="text-xs text-muted-foreground mt-1 max-w-sm">
        Pick an existing session from the sidebar, or click <span className="font-mono">+</span> on an agent to start a new one.
      </p>
    </div>
  )
}
