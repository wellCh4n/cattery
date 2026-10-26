"use client"

import { useEffect, useState } from "react"
import Cropper, { type Area } from "react-easy-crop"
import { Loader2, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"

export function AvatarCropDialog({ file, onClose, onSave }: {
  file: File
  onClose: () => void
  onSave: (image: Blob) => Promise<void>
}) {
  const [source, setSource] = useState<{ bitmap: ImageBitmap; url: string } | null>(null)
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [area, setArea] = useState<Area | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let bitmap: ImageBitmap | null = null
    const url = URL.createObjectURL(file)
    // Both the browser preview and ImageBitmap honor the image's orientation.
    createImageBitmap(file, { imageOrientation: "from-image" }).then(result => {
      if (cancelled) { result.close(); return }
      if (result.width * result.height > 16_000_000) {
        result.close()
        setError("Choose an image smaller than 16 megapixels.")
        return
      }
      bitmap = result
      setSource({ bitmap: result, url })
    }).catch(() => { if (!cancelled) setError("This image could not be opened. Try a JPEG, PNG or WebP file.") })
    return () => { cancelled = true; bitmap?.close(); URL.revokeObjectURL(url) }
  }, [file])

  async function save() {
    if (!source || !area || busy) return
    setBusy(true)
    setError(null)
    try {
      const canvas = document.createElement("canvas")
      canvas.width = canvas.height = 256
      const ctx = canvas.getContext("2d")
      if (!ctx) throw new Error("Could not crop this image")
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = "high"
      ctx.drawImage(source.bitmap, area.x, area.y, area.width, area.height, 0, 0, 256, 256)
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(value => value ? resolve(value) : reject(new Error("Could not crop this image")), "image/png")
      })
      await onSave(blob)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save avatar")
    } finally { setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
      {/* Scaling a dialog while the cropper measures it produces incorrect bounds. */}
      <DialogContent className="sm:max-w-md data-open:animate-none data-closed:animate-none" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Crop avatar</DialogTitle>
          <DialogDescription>Drag to reposition and zoom to frame your photo. Use the arrow keys to move it.</DialogDescription>
        </DialogHeader>
        <div className="relative h-72 overflow-hidden rounded-lg bg-muted" aria-label="Avatar crop preview">
          {source && <div className={busy ? "pointer-events-none opacity-70" : ""} aria-busy={busy} inert={busy}>
            <Cropper
              image={source.url} crop={crop} zoom={zoom} minZoom={1} maxZoom={4}
              aspect={1} cropShape="round" showGrid={false}
              onCropChange={setCrop} onZoomChange={setZoom}
              onCropAreaChange={(_, pixels) => setArea(pixels)}
              mediaProps={{ alt: "Photo to crop" }}
            />
          </div>}
          {!source && !error && <div className="absolute inset-0 flex items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>}
        </div>
        <div className="flex items-center gap-4 py-2">
          <span id="avatar-zoom-label" className="text-xs text-muted-foreground">Zoom</span>
          <Slider aria-labelledby="avatar-zoom-label" min={1} max={4} step={0.01} value={[zoom]} disabled={!source || busy} onValueChange={value => setZoom(Array.isArray(value) ? value[0] : value)} />
          <span className="w-9 text-right font-mono text-xs text-muted-foreground">{zoom.toFixed(1)}×</span>
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter className="gap-2">
          <Button variant="ghost" className="sm:mr-auto" disabled={!source || busy} onClick={() => { setZoom(1); setCrop({ x: 0, y: 0 }) }}><RotateCcw />Reset</Button>
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={!source || !area || busy} onClick={() => void save()}>{busy && <Loader2 className="animate-spin" />}Save avatar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
