import type { FilePreviewProps } from "./types"

export function HtmlPreview({ path, rawPathURL }: FilePreviewProps) {
  return (
    <iframe
      src={rawPathURL}
      title={path}
      sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
      className="h-full w-full border-0 bg-white"
    />
  )
}
