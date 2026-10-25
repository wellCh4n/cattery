"use client"

import { useEffect, useMemo, useState } from "react"
import type { DateRange } from "react-day-picker"
import {
  ArrowDown,
  ArrowDownRight,
  ArrowUp,
  ArrowUpRight,
  Boxes,
  CalendarDays,
  ChartColumn,
  Check,
  ChevronDown,
  Loader2,
  Users,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { RefreshButton } from "@/components/refresh-button"
import { UserAvatar } from "@/components/user-avatar"
import { UsageChart, type ChartSeries } from "@/components/usage-chart"
import { fetchUsage, type UsageRow } from "@/lib/api"
import { cn } from "@/lib/utils"
import {
  RANGE_PRESETS,
  TOKEN_KINDS,
  addTotals,
  autoBucket,
  cacheHitRate,
  change,
  emptyTotals,
  formatPercent,
  formatTokens,
  groupBy,
  periods as periodsIn,
  previousRange,
  rangeLabel,
  today,
  totalTokens,
  userKey,
  userName,
  type Bucket,
  type Group,
  type Totals,
} from "@/lib/usage"

// Groups charted by name before the rest fold into "Other": seven categorical
// slots, the eighth color is never cycled.
const CHARTED = 7
const OTHER = "other"
const OTHER_COLOR = "var(--muted-foreground)"
const seriesColor = (i: number) => `var(--series-${i + 1})`

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"

type Dim = "model" | "user"
const modelKey = (r: UsageRow) => r.model

const ofUser = (rows: UsageRow[], user: string | null) => (user ? rows.filter(r => userKey(r) === user) : rows)
const ofModel = (rows: UsageRow[], model: string | null) => (model ? rows.filter(r => r.model === model) : rows)
const sumRows = (rows: UsageRow[]) => rows.reduce<Totals>((t, r) => addTotals(t, r), emptyTotals())

// The largest groups get colors in name order, so a range that only
// reshuffles their ranking doesn't repaint them.
function slotColors(groups: Group[]): Map<string, string> {
  const charted = groups.slice(0, CHARTED).sort((a, b) => a.label.localeCompare(b.label))
  return new Map(charted.map((g, i) => [g.key, seriesColor(i)]))
}

interface Loaded {
  rows: UsageRow[]
  // The same-length range just before, for the changes on stats and rows.
  prev: UsageRow[]
  from: string
  to: string
  bucket: Bucket
}

// Token usage over a date range, sized to fit one screen: headline stats
// against the previous range, a chart per period (days, weeks or months by the
// range's length) and a breakdown table. "mine" is the signed-in user's own
// usage; "all" is everyone's, for admins. Models and users filter everything;
// table rows set those filters too.
export function UsageDashboard({ scope }: { scope: "mine" | "all" }) {
  const team = scope === "all"

  const [preset, setPreset] = useState("7d")
  const [custom, setCustom] = useState<[string, string]>(() => RANGE_PRESETS.find(p => p.id === "7d")!.range(today()))
  const [user, setUser] = useState<string | null>(null)
  const [model, setModel] = useState<string | null>(null)
  const [dim, setDim] = useState<Dim>(team ? "user" : "model")

  const [data, setData] = useState<Loaded | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  const [from, to] = preset === "custom" ? custom : RANGE_PRESETS.find(p => p.id === preset)!.range(today())
  const validRange = Boolean(from && to && from <= to)
  const bucket = validRange ? autoBucket(from, to) : "day"

  // Refetch keeps the previous render (dimmed) instead of flashing empty.
  useEffect(() => {
    if (!validRange) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- marks the fetch below as in flight
    setLoading(true)
    const [prevFrom, prevTo] = previousRange(from, to)
    Promise.all([
      fetchUsage(scope, { from, to, bucket, tz: TZ }),
      // Only summed, so the coarsest bucket keeps it small.
      fetchUsage(scope, { from: prevFrom, to: prevTo, bucket: "month", tz: TZ }),
    ])
      .then(([rows, prev]) => { if (!cancelled) { setData({ rows, prev, from, to, bucket }); setError(null) } })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : "failed to load usage") })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [scope, from, to, bucket, validRange, reload])

  const rows = useMemo(() => data?.rows ?? [], [data])
  const prev = useMemo(() => data?.prev ?? [], [data])

  // Each dimension's list ignores its own filter, so the picked entry still
  // shows among the others.
  const users = useMemo(() => groupBy(ofModel(rows, model), userKey, userName), [rows, model])
  const models = useMemo(() => groupBy(ofUser(rows, user), modelKey, modelKey), [rows, user])
  const scoped = useMemo(() => ofUser(ofModel(rows, model), user), [rows, user, model])
  const prevScoped = useMemo(() => ofUser(ofModel(prev, model), user), [prev, user, model])
  const modelColors = useMemo(() => slotColors(models), [models])

  // Filters stay put across ranges; a picked group missing here still shows.
  const allUsers = useMemo(() => groupBy(rows, userKey, userName), [rows])
  const allModels = useMemo(() => groupBy(rows, modelKey, modelKey), [rows])
  const userLabel = user ? allUsers.find(u => u.key === user)?.label ?? "Unknown" : null

  const totals = useMemo(() => sumRows(scoped), [scoped])
  const prevTotals = useMemo(() => sumRows(prevScoped), [prevScoped])

  const periods = useMemo(() => (data ? periodsIn(data.from, data.to, data.bucket) : []), [data])

  const activeUsers = new Set(scoped.filter(r => r.requests).map(userKey)).size
  const prevActiveUsers = new Set(prevScoped.filter(r => r.requests).map(userKey)).size

  // Tokens per period, stacked by model.
  const chart = useMemo(() => {
    if (!data) return null
    const index = new Map(periods.map((p, i) => [p, i]))
    // In slot order: the palette is checked for neighbors in that order.
    const series: ChartSeries[] = [...modelColors].map(([key, color]) => ({ key, label: key, color }))
    if (models.length > series.length) series.push({ key: OTHER, label: "Other", color: OTHER_COLOR })
    const pos = new Map(series.map((s, i) => [s.key, i]))
    const v = periods.map(() => series.map(() => 0))
    for (const r of scoped) {
      const i = index.get(r.period)
      if (i !== undefined) v[i][pos.get(r.model) ?? series.length - 1] += totalTokens(r)
    }
    return { series, values: v }
  }, [data, periods, models, modelColors, scoped])

  const swatch = (color: string | undefined) => (
    <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: color ?? OTHER_COLOR }} />
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 font-heading text-base font-semibold">{team ? "Team usage" : "Usage"}</h1>
        <RangePicker
          preset={preset}
          custom={custom}
          onPreset={setPreset}
          onCustom={range => { setCustom(range); setPreset("custom") }}
        />
        <FilterPicker
          icon={<Boxes className="size-3.5 text-muted-foreground" />}
          allLabel="All models"
          groups={allModels}
          selected={model}
          selectedLabel={model}
          mono
          onSelect={setModel}
        />
        {team && (
          <FilterPicker
            icon={<Users className="size-3.5 text-muted-foreground" />}
            allLabel="All users"
            groups={allUsers}
            selected={user}
            selectedLabel={userLabel}
            onSelect={setUser}
          />
        )}
        <RefreshButton refreshing={loading} onClick={() => setReload(n => n + 1)} title="Refresh" className="ml-auto" />
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {!data ? (
        <div className="flex h-80 items-center justify-center text-muted-foreground">
          {loading && <Loader2 className="size-5 animate-spin" />}
        </div>
      ) : (
        <div className={cn("flex min-h-0 flex-1 flex-col gap-4 transition-opacity", loading && "opacity-60")}>
          <div className="grid grid-cols-2 divide-x rounded-lg border sm:flex">
            <Stat
              label="Total tokens"
              value={formatTokens(totalTokens(totals))}
              exact={totalTokens(totals).toLocaleString()}
              delta={change(totalTokens(totals), totalTokens(prevTotals))}
            />
            <Stat
              label="Requests"
              value={totals.requests.toLocaleString()}
              delta={change(totals.requests, prevTotals.requests)}
            />
            <CacheStat totals={totals} prev={prevTotals} />
            {team && (
              <Stat
                label="Active users"
                value={activeUsers.toLocaleString()}
                delta={change(activeUsers, prevActiveUsers)}
              />
            )}
          </div>

          <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-5">
            <section className="flex min-h-72 flex-col rounded-lg border p-4 lg:col-span-3">
              <h2 className="mb-3 text-sm font-medium">Usage over time</h2>
              {scoped.length === 0 ? (
                <NoUsage team={team} filtered={Boolean(user || model)} />
              ) : (
                chart && (
                  <UsageChart
                    periods={periods}
                    bucket={data.bucket}
                    unit="tokens"
                    {...chart}
                  />
                )
              )}
            </section>

            <section className="flex min-h-48 flex-col overflow-hidden rounded-lg border lg:col-span-2">
              <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5">
                <h2 className="flex-1 text-sm font-medium">Breakdown</h2>
                {team && (
                  <Tabs value={dim} onValueChange={v => setDim(v as Dim)}>
                    <TabsList>
                      <TabsTrigger value="user" className="px-2.5 text-xs">Users</TabsTrigger>
                      <TabsTrigger value="model" className="px-2.5 text-xs">Models</TabsTrigger>
                    </TabsList>
                  </Tabs>
                )}
              </div>
              {dim === "user" && team ? (
                <Breakdown
                  key="user"
                  name="User"
                  groups={users}
                  selected={user}
                  onSelect={k => setUser(k === user ? null : k)}
                  lead={g => (
                    <span className="flex min-w-0 items-center gap-2">
                      {g.key === "unknown"
                        ? <span className="italic text-muted-foreground">{g.label}</span>
                        : <><UserAvatar username={g.label} className="size-5 text-[10px]" /><span className="truncate">{g.label}</span></>}
                    </span>
                  )}
                />
              ) : (
                <Breakdown
                  key="model"
                  name="Model"
                  groups={models}
                  selected={model}
                  onSelect={k => setModel(k === model ? null : k)}
                  lead={g => (
                    <span className="flex min-w-0 items-center gap-2">
                      {swatch(modelColors.get(g.key))}
                      <span className="truncate font-mono text-xs">{g.label}</span>
                    </span>
                  )}
                />
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  )
}

function NoUsage({ team, filtered }: { team: boolean; filtered: boolean }) {
  return (
    <Empty className="min-h-40 border">
      <EmptyHeader>
        <EmptyMedia variant="icon"><ChartColumn /></EmptyMedia>
        <EmptyTitle>No usage in this range</EmptyTitle>
        <EmptyDescription className="text-xs">
          {filtered
            ? "Nothing matches these filters. Clear them or pick a longer range."
            : team
              ? "Every model request the agent makes is counted here, for the user who started the session."
              : "Every model request the agent makes in your sessions is counted here."}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

// Calendar days as local dates and back.
const toDate = (day: string) => new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)))

// Presets beside a range calendar; a preset applies at once, a custom range on
// Apply. Like most range pickers, the first click starts a new range and the
// second ends it (an earlier day swaps them; the same day twice is one day).
function RangePicker({ preset, custom, onPreset, onCustom }: {
  preset: string
  custom: [string, string]
  onPreset: (id: string) => void
  onCustom: (range: [string, string]) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<DateRange | undefined>()
  const label = preset === "custom" ? rangeLabel(custom[0], custom[1]) : RANGE_PRESETS.find(p => p.id === preset)!.label
  return (
    <Popover
      open={open}
      onOpenChange={o => {
        setOpen(o)
        // The range in use, preset or custom.
        const [from, to] = preset === "custom" ? custom : RANGE_PRESETS.find(p => p.id === preset)!.range(today())
        if (o) setDraft({ from: toDate(from), to: toDate(to) })
      }}
    >
      <PopoverTrigger render={<Button variant="outline" size="sm" className="gap-1.5 text-xs" />}>
        <CalendarDays className="size-3.5 text-muted-foreground" />
        {label}
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto flex-row gap-0 p-0">
        <div className="flex w-36 shrink-0 flex-col gap-0.5 border-r p-1">
          {RANGE_PRESETS.map(p => (
            <button
              key={p.id}
              type="button"
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-none hover:bg-accent focus-visible:bg-accent"
              onClick={() => { onPreset(p.id); setOpen(false) }}
            >
              <span className="flex-1">{p.label}</span>
              {preset === p.id && <Check className="size-3.5" />}
            </button>
          ))}
        </div>
        <div className="flex flex-col">
          <Calendar
            mode="range"
            numberOfMonths={2}
            showOutsideDays={false}
            defaultMonth={draft?.to ? new Date(draft.to.getFullYear(), draft.to.getMonth() - 1) : undefined}
            selected={draft}
            onSelect={setDraft}
            resetOnSelect
            disabled={{ after: new Date() }}
            className="p-3"
          />
          <div className="flex items-center gap-2 border-t px-3 py-2">
            <span className="flex-1 text-xs text-muted-foreground">
              {!draft?.from
                ? "Pick a start day"
                : draft.to
                  ? rangeLabel(today(draft.from), today(draft.to))
                  : `${rangeLabel(today(draft.from), today(draft.from))} – pick an end day`}
            </span>
            <Button
              size="sm"
              className="text-xs"
              disabled={!draft?.from || !draft.to}
              onClick={() => {
                if (!draft?.from || !draft.to) return
                onCustom([today(draft.from), today(draft.to)])
                setOpen(false)
              }}
            >
              Apply
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function FilterPicker({ icon, allLabel, groups, selected, selectedLabel, mono, onSelect }: {
  icon: React.ReactNode
  allLabel: string
  groups: Group[]
  selected: string | null
  selectedLabel: string | null
  mono?: boolean
  onSelect: (key: string | null) => void
}) {
  return (
    <div className="flex items-center">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="outline" size="sm" className={cn("max-w-64 gap-1.5 text-xs", selected && "rounded-r-none bg-muted/60")} />}
        >
          {icon}
          <span className={cn("truncate", selected && mono && "font-mono")}>{selectedLabel ?? allLabel}</span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-72 w-56">
          <DropdownMenuRadioGroup value={selected ?? ""} onValueChange={v => onSelect((v as string) || null)}>
            <DropdownMenuRadioItem value="" closeOnClick className="cursor-pointer text-xs">{allLabel}</DropdownMenuRadioItem>
            {groups.length > 0 && <DropdownMenuSeparator />}
            {groups.map(g => (
              <DropdownMenuRadioItem key={g.key} value={g.key} closeOnClick className="cursor-pointer text-xs">
                <span className={cn("flex-1 truncate", mono && "font-mono")}>{g.label}</span>
                <span className="text-muted-foreground tabular-nums">{formatTokens(totalTokens(g))}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {selected && (
        <Button variant="outline" size="icon-sm" className="-ml-px rounded-l-none bg-muted/60" title={`Show ${allLabel.toLowerCase()}`} onClick={() => onSelect(null)}>
          <X className="size-3.5" />
        </Button>
      )}
    </div>
  )
}

// A change against the previous range: up or down, never good or bad.
// Nothing without a previous value to compare with.
function Delta({ value, points }: { value: number | null; points?: boolean }) {
  if (value === null || !Number.isFinite(value)) return null
  const flat = Math.abs(value) < (points ? 0.005 : 0.0005)
  const Icon = value > 0 ? ArrowUpRight : ArrowDownRight
  const text = points
    ? `${Math.abs(value * 100).toFixed(Math.abs(value) < 0.1 ? 1 : 0).replace(/\.0$/, "")} pts`
    : formatPercent(Math.abs(value))
  return (
    <span className="flex items-center gap-0.5 text-xs text-muted-foreground tabular-nums" title="Compared with the previous range of the same length">
      {flat ? "No change" : <><Icon className="size-3" />{text}</>}
    </span>
  )
}

function Stat({ label, value, exact, delta, points }: {
  label: string
  value: string
  exact?: string
  delta: number | null
  points?: boolean
}) {
  return (
    <div className="min-w-0 flex-1 px-4 py-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <span className="text-lg font-semibold tabular-nums" title={exact}>{value}</span>
        <Delta value={delta} points={points} />
      </div>
    </div>
  )
}

function CacheStat({ totals, prev }: { totals: Totals; prev: Totals }) {
  const rate = cacheHitRate(totals)
  const prevRate = cacheHitRate(prev)
  return (
    <Stat
      label="Cache hit rate"
      value={rate === null ? "—" : formatPercent(rate)}
      exact={`${totals.cache_read.toLocaleString()} of ${(totals.input + totals.cache_read + totals.cache_write).toLocaleString()} prompt tokens read from cache`}
      delta={rate !== null && prevRate !== null ? rate - prevRate : null}
      points
    />
  )
}

type SortKey = "name" | "requests" | "total"

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "requests", label: "Requests" },
  { key: "total", label: "Tokens" },
]

// Groups with their share of the range; the token kinds show on hover. Clicking a row filters the page to it; clicking it again clears that.
function Breakdown({ name, groups, lead, selected, onSelect }: {
  name: string
  groups: Group[]
  lead: (g: Group) => React.ReactNode
  selected: string | null
  onSelect: (key: string) => void
}) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "total", desc: true })
  const grand = totalTokens(groups.reduce<Totals>((t, g) => addTotals(t, g), emptyTotals()))
  const sorted = useMemo(() => {
    const value = (g: Group): number | string => {
      if (sort.key === "name") return g.label.toLowerCase()
      if (sort.key === "total") return totalTokens(g)
      return g.requests
    }
    return [...groups].sort((a, b) => {
      const x = value(a)
      const y = value(b)
      const c = x < y ? -1 : x > y ? 1 : 0
      return sort.desc ? -c : c
    })
  }, [groups, sort])

  if (groups.length === 0) {
    return <div className="px-3 py-8 text-center text-xs text-muted-foreground">No usage in this range</div>
  }
  const header = (key: SortKey, label: string, right = true) => {
    const Arrow = sort.desc ? ArrowDown : ArrowUp
    return (
      <th className={cn("px-3 py-2 font-medium", right ? "text-right" : "text-left")} aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : undefined}>
        <button
          type="button"
          className={cn("inline-flex cursor-pointer items-center gap-0.5 hover:text-foreground", sort.key === key && "text-foreground")}
          onClick={() => setSort(s => ({ key, desc: s.key === key ? !s.desc : key !== "name" }))}
        >
          {label}
          {sort.key === key && <Arrow className="size-3" />}
        </button>
      </th>
    )
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-background text-xs text-muted-foreground">
          <tr>
            {header("name", name, false)}
            <th className="w-32 px-3 py-2 text-left font-medium">Share</th>
            {COLUMNS.map(c => header(c.key, c.label))}
          </tr>
        </thead>
        <tbody>
          {sorted.map(g => {
            const total = totalTokens(g)
            const share = grand ? total / grand : 0
            return (
              <tr
                key={g.key}
                className={cn("cursor-pointer border-t hover:bg-muted/40", selected === g.key && "bg-muted/60 hover:bg-muted/60")}
                onClick={() => onSelect(g.key)}
                title={[
                  ...TOKEN_KINDS.map(k => `${k.label}: ${g[k.key].toLocaleString()}`),
                  selected === g.key ? "Click to clear this filter" : `Click to filter to ${g.label}`,
                ].join("\n")}
              >
                <td className="max-w-56 px-3 py-1.5">{lead(g)}</td>
                <td className="px-3 py-1.5">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 rounded-full bg-muted">
                      <div className="h-full rounded-full bg-foreground/40" style={{ width: `${share * 100}%` }} />
                    </div>
                    <span className="w-8 text-right text-xs text-muted-foreground tabular-nums">{formatPercent(share)}</span>
                  </div>
                </td>
                <td className="px-3 py-1.5 text-right text-muted-foreground tabular-nums">{g.requests.toLocaleString()}</td>
                <td className="px-3 py-1.5 text-right font-medium tabular-nums">
                  {formatTokens(total)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
