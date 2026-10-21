import { Markdown } from "@/components/markdown"
import type { FilePreviewProps } from "./types"

export function MarkdownPreview({ content }: FilePreviewProps) {
  return (
    <div className="mx-auto w-full max-w-4xl p-6">
      <Markdown className="text-foreground">{content}</Markdown>
    </div>
  )
}
