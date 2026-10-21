import type { FilePreviewProps } from "./types"

export function ImagePreview({ path, rawURL }: FilePreviewProps) {
  return (
    <div className="flex h-full items-center justify-center p-4">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={rawURL} alt={path} className="max-h-full max-w-full object-contain" />
    </div>
  )
}
