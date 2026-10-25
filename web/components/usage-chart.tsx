"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import { formatTokens, niceScale, periodLabel, periodTitle, type Bucket } from "@/lib/usage"

export interface ChartSeries {
  key: string
  label: string
  color: string
}

// Stacked columns, one per period: values[i][j] is series j in periods[i].
// The tooltip lists every series of the column under the pointer or focus.
export function UsageChart({ periods, bucket, series, values }: {
  periods: string[]
  bucket: Bucket
  series: ChartSeries[]
  values: number[][]
}) {
  const [active, setActive] = useState<number | null>(null)
  const totals = values.map(v => v.reduce((a, b) => a + b, 0))
  const { top, step } = niceScale(Math.max(0, ...totals))
  const ticks: number[] = []
  for (let t = 0; t <= top; t += step) ticks.push(t)
  const labelEvery = Math.ceil(periods.length / 8)
  const empty = totals.every(t => t === 0)

  return (
    <div className="flex flex-col gap-3">
      {series.length > 1 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {series.map(s => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-[2px]" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <div className="flex pt-2">
        <div className="relative w-12 shrink-0 text-2xs text-muted-foreground tabular-nums">
          {ticks.map(t => (
            <span key={t} className="absolute right-2 -translate-y-1/2" style={{ bottom: `${(t / top) * 100}%` }}>
              {formatTokens(t)}
            </span>
          ))}
        </div>
        <div className="relative h-56 flex-1" onPointerLeave={() => setActive(null)}>
          {ticks.map(t => (
            <div
              key={t}
              className={cn("absolute inset-x-0 border-t", t === 0 ? "border-border" : "border-border/60")}
              style={{ bottom: `${(t / top) * 100}%` }}
            />
          ))}
          {empty && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
              No usage in this range
            </div>
          )}
          <div className="absolute inset-0 flex">
            {periods.map((p, i) => (
              <div
                key={p}
                tabIndex={0}
                aria-label={`${periodTitle(p, bucket)}: ${formatTokens(totals[i])} tokens`}
                className={cn(
                  "flex h-full min-w-0 flex-1 items-end justify-center outline-none",
                  active === i && "bg-muted/60",
                )}
                onPointerEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
              >
                {totals[i] > 0 && (
                  <div
                    className="flex w-[70%] max-w-6 flex-col-reverse gap-[2px] overflow-hidden rounded-t-[4px]"
                    style={{ height: `${(totals[i] / top) * 100}%` }}
                  >
                    {series.map((s, j) => values[i][j] > 0 && (
                      <div key={s.key} className="min-h-px" style={{ flex: `${values[i][j]} 0 0`, background: s.color }} />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          {active !== null && (
            <Tooltip
              title={periodTitle(periods[active], bucket)}
              total={totals[active]}
              series={series}
              values={values[active]}
              x={(active + 0.5) / periods.length}
            />
          )}
        </div>
      </div>
      <div className="ml-12 flex text-2xs text-muted-foreground">
        {periods.map((p, i) => (
          <div key={p} className="flex min-w-0 flex-1 justify-center overflow-visible whitespace-nowrap">
            {i % labelEvery === 0 ? periodLabel(p, bucket) : null}
          </div>
        ))}
      </div>
    </div>
  )
}

function Tooltip({ title, total, series, values, x }: {
  title: string
  total: number
  series: ChartSeries[]
  values: number[]
  x: number
}) {
  // Opens away from the nearer edge so it never leaves the chart.
  const side = x < 0.5 ? { left: `calc(${x * 100}% + 16px)` } : { right: `calc(${(1 - x) * 100}% + 16px)` }
  return (
    <div
      className="pointer-events-none absolute top-2 z-10 min-w-40 rounded-lg border bg-popover px-3 py-2 text-xs shadow-md"
      style={side}
    >
      <div className="mb-1.5 text-muted-foreground">{title}</div>
      <div className="mb-1.5 flex items-baseline justify-between gap-4">
        <span className="font-semibold tabular-nums">{total.toLocaleString()}</span>
        <span className="text-muted-foreground">tokens</span>
      </div>
      {series.length > 1 && series.map((s, j) => (
        <div key={s.key} className="flex items-center gap-2 py-0.5">
          <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: s.color }} />
          <span className="font-medium tabular-nums">{formatTokens(values[j])}</span>
          <span className="truncate text-muted-foreground">{s.label}</span>
        </div>
      ))}
    </div>
  )
}
