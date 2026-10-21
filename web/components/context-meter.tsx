"use client"

import { InputGroupButton } from "@/components/ui/input-group"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { type SessionUsageData } from "@/lib/chat-stream-store"
import { cn } from "@/lib/utils"

// How full the model's context is, as the agent reports it after each turn.
// A ring in the composer; clicking it opens the breakdown. The hatched band at
// the end of the window is the auto-compact buffer: pi compacts the context
// once it grows into it.

const hatch = "bg-[repeating-linear-gradient(-45deg,var(--color-muted-foreground)_0_1.5px,transparent_1.5px_3.5px)] opacity-60"

function tokens(n: number): string {
  if (n < 1000) return String(n)
  const [value, unit] = n < 1_000_000 ? [n / 1000, "k"] : [n / 1_000_000, "M"]
  return `${Number(value.toFixed(1))}${unit}`
}

function percent(n: number): string {
  if (n > 0 && n < 0.1) return "<0.1%"
  return `${n.toFixed(1)}%`
}

function Ring({ used, buffer }: { used: number; buffer: number }) {
  // pathLength=100 makes dash lengths read as percentages of the circle.
  return (
    <svg viewBox="0 0 20 20" className="block size-6 -rotate-90" aria-hidden="true">
      <circle cx="10" cy="10" r="8.5" fill="none" strokeWidth="3" className="stroke-muted group-hover/button:stroke-muted-foreground/25 group-aria-expanded/button:stroke-muted-foreground/25" />
      {buffer > 0 && (
        <circle
          cx="10" cy="10" r="8.5" fill="none" strokeWidth="3" pathLength={100}
          strokeDasharray={`${buffer} 100`} strokeDashoffset={buffer - 100}
          className="stroke-muted-foreground/40"
        />
      )}
      {used > 0 && (
        <circle
          cx="10" cy="10" r="8.5" fill="none" strokeWidth="3" pathLength={100}
          strokeDasharray={`${Math.min(used, 100)} 100`} strokeLinecap="round"
          className="stroke-foreground"
        />
      )}
    </svg>
  )
}

function Row({ swatch, label, value, share }: { swatch?: string; label: string; value: string; share?: string }) {
  return (
    <div className="flex items-center gap-2">
      {swatch !== undefined && <span className={cn("size-2.5 shrink-0 rounded-[3px]", swatch)} />}
      <span className="flex-1 text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
      {share !== undefined && <span className="w-12 text-right tabular-nums text-muted-foreground">{share}</span>}
    </div>
  )
}

export function ContextMeter({ usage, className }: { usage: SessionUsageData; className?: string }) {
  const { contextTokens: used, contextWindow: size, reserveTokens: reserve } = usage
  const usedPct = used === null ? 0 : (used / size) * 100
  const bufferPct = (reserve / size) * 100
  const free = used === null ? null : Math.max(0, size - used - reserve)
  const headline = used === null ? "—" : `${Math.round(usedPct)}%`
  const summary = used === null
    ? `${tokens(size)} context · updates after the next response`
    : `${headline} · ${tokens(used)} / ${tokens(size)}`

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <InputGroupButton size="icon-sm" variant="ghost" className={cn("self-center rounded-full dark:hover:bg-muted dark:aria-expanded:bg-muted", className)} aria-label={`Context: ${summary}`} />
              }
            />
          }
        >
          <Ring used={usedPct} buffer={bufferPct} />
        </TooltipTrigger>
        <TooltipContent>{summary}</TooltipContent>
      </Tooltip>
      <PopoverContent side="top" align="start" className="w-72 gap-3 p-3">
        <div className="flex flex-col gap-2">
          <div className="font-medium">Context</div>
          <div className="flex items-baseline justify-between">
            <span className="text-base tabular-nums">{used === null ? "—" : `${headline} used`}</span>
            <span className="tabular-nums text-muted-foreground">
              {used === null ? "—" : tokens(used)} / {tokens(size)}
            </span>
          </div>
          <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="bg-foreground" style={{ width: `${Math.min(usedPct, 100)}%` }} />
            <div className="flex-1" />
            {reserve > 0 && <div className={hatch} style={{ width: `${bufferPct}%` }} />}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Row swatch="bg-foreground" label="Used" value={used === null ? "—" : tokens(used)} share={used === null ? "—" : percent(usedPct)} />
          <Row swatch="bg-muted" label="Free" value={free === null ? "—" : tokens(free)} share={free === null ? "—" : percent((free / size) * 100)} />
          {reserve > 0 && <Row swatch={hatch} label="Auto-compact buffer" value={tokens(reserve)} share={percent(bufferPct)} />}
        </div>
        <p className="text-xs text-muted-foreground">
          {used === null
            ? "Just compacted. Usage updates after the next response."
            : reserve > 0
              ? `Auto-compacts at ${tokens(size - reserve)}.`
              : "Auto-compact is off."}
        </p>
        <Separator />
        <div className="flex flex-col gap-1.5">
          <div className="font-medium">This session</div>
          <Row label="Input" value={tokens(usage.tokens.input)} />
          <Row label="Output" value={tokens(usage.tokens.output)} />
          <Row label="Cache read" value={tokens(usage.tokens.cacheRead)} />
          <Row label="Cache write" value={tokens(usage.tokens.cacheWrite)} />
          <Row label="Messages" value={String(usage.userMessages)} />
          <Row label="Tool calls" value={String(usage.toolCalls)} />
        </div>
      </PopoverContent>
    </Popover>
  )
}
