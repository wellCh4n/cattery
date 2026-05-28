"use client"

// Tree — single tree primitive shared by the sidebar's harness/session tree
// and the file browser's folder/file tree. Consumers build a TreeNode[]
// description of their data; this component owns row chrome (height, gap,
// hover, selected highlight), indent-by-depth, the chevron, lazy-load
// spinners, and drop targets. New trees should reuse this rather than
// hand-rolling another row layout.
//
// The two existing trees are 2-level (harness → session) and N-level
// (folder/file recursion); both fit the same data model — `children` may
// be undefined (not loaded yet), [] (loaded, empty), or populated.

import { ChevronRight, Loader2 } from "lucide-react"
import { useRef, useState, type ReactNode } from "react"
import { TreeRow } from "@/components/tree-row"
import { cn } from "@/lib/utils"

const INDENT_PX = 8
const BASE_PX = 8
const CHEVRON_PX = 16
const CHEVRON_CENTER_PX = CHEVRON_PX / 2

// Internal drag MIME — distinguishes a tree-item drag from an OS file drag.
// Browsers force MIME types to lowercase, so keep this lowercase.
const TREE_ITEM_MIME = "application/x-cattery-tree-item"

export interface TreeNode {
  // Stable across renders; used as the React key.
  id: string
  // Whether this row should show a chevron (and reserve the slot for it).
  expandable: boolean
  expanded?: boolean
  // undefined = not loaded yet; [] = loaded, empty; array = loaded.
  children?: TreeNode[]
  // Show a loading spinner under the row when expanded but children are
  // still undefined.
  loadingChildren?: boolean
  selected?: boolean
  // Row body — usually icon + name + inline badge/size. Rendered after the
  // chevron slot.
  body: ReactNode
  // Hover-revealed actions (right-aligned). Use TreeRowAction components.
  actions?: ReactNode
  // Optional secondary line under the row (e.g. owner · role meta). The
  // caller controls its left padding.
  subline?: ReactNode
  // Click on the row body. Expandable rows usually pass their toggle here
  // so clicking anywhere on the row expands; leaf rows can route or open.
  onClick?: () => void
  // If defined, the row becomes a drop target for OS files (browser
  // dataTransfer.files). Drop highlight is managed internally so consumers
  // don't reimplement dragenter/leave depth-counting per row.
  onFilesDropped?: (files: File[]) => Promise<void> | void
  // Internal drag-and-drop. If `dragId` is set the row becomes draggable —
  // dropping it on another row whose `onItemDropped` is set fires that
  // callback with the source's id. Use this to move entries between
  // folders without reimplementing drag mechanics per tree.
  dragId?: string
  onItemDropped?: (sourceId: string) => Promise<void> | void
  // If set, replaces the row body entirely (used for inline rename).
  editing?: ReactNode
}

interface TreeProps {
  items: TreeNode[]
  className?: string
}

export function Tree({ items, className }: TreeProps) {
  return (
    <div className={className}>
      {items.map(item => <TreeItemView key={item.id} node={item} depth={0} />)}
    </div>
  )
}

function TreeItemView({ node, depth }: { node: TreeNode; depth: number }) {
  const [dropTarget, setDropTarget] = useState(false)
  // dragenter/dragleave fire for every nested element traversal — counting
  // depth lets us only clear the highlight when the cursor truly leaves
  // the row, not when it crosses an inner span boundary.
  const dropDepthRef = useRef(0)
  const indent = depth * INDENT_PX + BASE_PX
  const contentIndent = node.expandable ? indent : leafContentIndent(depth)

  const acceptsFiles = !!node.onFilesDropped
  const acceptsItems = !!node.onItemDropped
  const isDraggable = !!node.dragId

  const dropHandlers = (acceptsFiles || acceptsItems)
    ? {
        onDragEnter(e: React.DragEvent<HTMLDivElement>) {
          const types = e.dataTransfer.types
          const isItem = acceptsItems && types.includes(TREE_ITEM_MIME)
          const isFile = acceptsFiles && types.includes("Files")
          if (!isItem && !isFile) return
          // Don't highlight self when an internal drag hovers its own row.
          if (isItem && node.dragId && e.dataTransfer.getData(TREE_ITEM_MIME) === node.dragId) return
          e.preventDefault()
          e.stopPropagation()
          dropDepthRef.current += 1
          setDropTarget(true)
        },
        onDragOver(e: React.DragEvent<HTMLDivElement>) {
          const types = e.dataTransfer.types
          const isItem = acceptsItems && types.includes(TREE_ITEM_MIME)
          const isFile = acceptsFiles && types.includes("Files")
          if (!isItem && !isFile) return
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = isItem ? "move" : "copy"
        },
        onDragLeave(e: React.DragEvent<HTMLDivElement>) {
          e.preventDefault()
          e.stopPropagation()
          dropDepthRef.current = Math.max(0, dropDepthRef.current - 1)
          if (dropDepthRef.current === 0) setDropTarget(false)
        },
        async onDrop(e: React.DragEvent<HTMLDivElement>) {
          e.preventDefault()
          e.stopPropagation()
          dropDepthRef.current = 0
          setDropTarget(false)
          // Internal item drag wins over file drag (a Chrome quirk: even an
          // internal drag may carry an empty Files array).
          const itemId = acceptsItems ? e.dataTransfer.getData(TREE_ITEM_MIME) : ""
          if (itemId && node.onItemDropped) {
            if (itemId === node.dragId) return
            await node.onItemDropped(itemId)
            return
          }
          if (acceptsFiles) {
            const files = Array.from(e.dataTransfer.files)
            if (files.length > 0) await node.onFilesDropped!(files)
          }
        },
      }
    : undefined

  const dragHandlers = isDraggable
    ? {
        draggable: true,
        onDragStart(e: React.DragEvent<HTMLDivElement>) {
          e.stopPropagation()
          e.dataTransfer.effectAllowed = "move"
          e.dataTransfer.setData(TREE_ITEM_MIME, node.dragId!)
          // Some browsers refuse to start a drag without text/plain set.
          e.dataTransfer.setData("text/plain", node.dragId!)
        },
      }
    : undefined

  return (
    <>
      {node.editing ? (
        <div
          className="relative flex h-7 items-center gap-1 bg-muted/40"
          style={{ paddingLeft: contentIndent, paddingRight: BASE_PX }}
        >
          <GuideLines depth={depth} />
          {node.expandable && <span className="size-4 shrink-0" />}
          {node.editing}
        </div>
      ) : (
        <TreeRow
          selected={node.selected}
          onClick={node.onClick}
          style={{ paddingLeft: contentIndent, paddingRight: BASE_PX }}
          className={cn("relative", dropTarget && "bg-primary/10 ring-1 ring-inset ring-primary")}
          {...dragHandlers}
          {...dropHandlers}
        >
          <GuideLines depth={depth} />
          {node.expandable ? (
            <span
              className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
              aria-hidden="true"
            >
              <ChevronRight className={cn("size-3 transition-transform", node.expanded && "rotate-90")} />
            </span>
          ) : null}
          {node.body}
          {node.actions}
        </TreeRow>
      )}
      {node.subline}
      {node.expanded && node.loadingChildren && !node.children && (
        <div
          className="relative flex h-7 items-center text-muted-foreground"
          style={{ paddingLeft: leafContentIndent(depth + 1) }}
        >
          <GuideLines depth={depth + 1} />
          <Loader2 className="size-3 animate-spin" />
        </div>
      )}
      {node.expanded && node.children?.map(child => (
        <TreeItemView key={child.id} node={child} depth={depth + 1} />
      ))}
    </>
  )
}

function guideLeft(depthIndex: number) {
  return depthIndex * INDENT_PX + BASE_PX + CHEVRON_CENTER_PX
}

function leafContentIndent(depth: number) {
  if (depth === 0) return BASE_PX
  return guideLeft(depth - 1) + INDENT_PX
}

// GuideLines — vertical alignment guides for nested rows. Each rendered
// guide sits at an ancestor's chevron column (depth `i`'s chevron center
// is at i*INDENT_PX + BASE_PX + half-chevron). Always faintly visible; the
// guide connecting to the immediate parent (the last one) brightens when
// the row is hovered, mirroring VS Code's explorer active-guide style.
function GuideLines({ depth }: { depth: number }) {
  if (depth === 0) return null
  return (
    <>
      {Array.from({ length: depth }, (_, i) => {
        const isParentGuide = i === depth - 1
        return (
          <span
            key={i}
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-y-0 w-px bg-border transition-colors",
              isParentGuide && "group-hover/treerow:bg-foreground/40",
            )}
            style={{ left: guideLeft(i) }}
          />
        )
      })}
    </>
  )
}
