"use client"

import { useEffect, useMemo, useState } from "react"
import { ChevronDown, Loader2, Users, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
  emptyTotals,
  formatTokens,
  groupBy,
  periods as periodsIn,
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

type Stack = "user" | "model" | "type"
const STACK_LABELS: Record<Stack, string> = { user: "By user", model: "By model", type: "By type" }
const modelKey = (r: UsageRow) => r.model

// The largest groups get colors in name order, so a range that only
// reshuffles their ranking doesn't repaint them.
function slotColors(groups: Group[]): Map<string, string> {
  const charted = groups.slice(0, CHARTED).sort((a, b) => a.label.localeCompare(b.label))
  return new Map(charted.map((g, i) => [g.key, seriesColor(i)]))
}

// Token usage over a date range: totals, a chart per period and tables. "mine"
// is the signed-in user's own usage by model; "all" is everyone's, per user.
export function UsageDashboard({ scope }: { scope: "mine" | "all" }) {
  const stacks: Stack[] = scope === "all" ? ["user", "model", "type"] : ["model", "type"]

  const [preset, setPreset] = useState("30d")
  const [custom, setCustom] = useState(() => RANGE_PRESETS[1].range(today()))
  const [bucket, setBucket] = useState<Bucket>("day")
  const [user, setUser] = useState<string | null>(null)
  const [stackBy, setStackBy] = useState<Stack>(stacks[0])

  // Rows with the query they answer, so a refetch keeps drawing them as they were.
  const [data, setData] = useState<{ rows: UsageRow[]; from: string; to: string; bucket: Bucket } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  const [from, to] = preset === "custom" ? custom : RANGE_PRESETS.find(p => p.id === preset)!.range(today())
  const validRange = Boolean(from && to && from <= to)

  // Refetch keeps the previous render (dimmed) instead of flashing empty.
  useEffect(() => {
    if (!validRange) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- marks the fetch below as in flight
    setLoading(true)
    fetchUsage(scope, { from, to, bucket, tz: TZ })
      .then(rows => { if (!cancelled) { setData({ rows, from, to, bucket }); setError(null) } })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : "failed to load usage") })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [scope, from, to, bucket, validRange, reload])

  const rows = useMemo(() => data?.rows ?? [], [data])
  const users = useMemo(() => groupBy(rows, userKey, userName), [rows])
  const selected = scope === "all" ? users.find(u => u.key === user) ?? null : null
  const scoped = useMemo(() => (selected ? rows.filter(r => userKey(r) === selected.key) : rows), [rows, selected])
  const totals = useMemo(() => scoped.reduce<Totals>((t, r) => addTotals(t, r), emptyTotals()), [scoped])
  const models = useMemo(() => groupBy(scoped, modelKey, modelKey), [scoped])
  const userColors = useMemo(() => slotColors(users), [users])
  const modelColors = useMemo(() => slotColors(models), [models])

  // A selected user is already one series; stack them by model instead.
  const stack: Stack = selected && stackBy === "user" ? "model" : stackBy
  const chart = useMemo(() => {
    if (!data) return null
    const periods = periodsIn(data.from, data.to, data.bucket)
    const index = new Map(periods.map((p, i) => [p, i]))
    const values = (series: ChartSeries[]) => periods.map(() => series.map(() => 0))
    if (stack === "type") {
      const series = TOKEN_KINDS.map((k, i) => ({ key: k.key, label: k.label, color: seriesColor(i) }))
      const v = values(series)
      for (const r of scoped) {
        const i = index.get(r.period)
        if (i !== undefined) TOKEN_KINDS.forEach((k, j) => { v[i][j] += r[k.key] })
      }
      return { periods, series, values: v, bucket: data.bucket }
    }
    const [groups, colors, key] = stack === "user" ? [users, userColors, userKey] : [models, modelColors, modelKey]
    // In slot order: the palette is checked for neighbors in that order.
    const label = new Map(groups.map(g => [g.key, g.label]))
    const series: ChartSeries[] = [...colors].map(([k, color]) => ({ key: k, label: label.get(k)!, color }))
    if (groups.length > series.length) series.push({ key: OTHER, label: "Other", color: OTHER_COLOR })
    const pos = new Map(series.map((s, i) => [s.key, i]))
    const v = values(series)
    for (const r of scoped) {
      const i = index.get(r.period)
      if (i !== undefined) v[i][pos.get(key(r)) ?? series.length - 1] += totalTokens(r)
    }
    return { periods, series, values: v, bucket: data.bucket }
  }, [data, stack, users, userColors, models, modelColors, scoped])

  const swatch = (colors: Map<string, string>, key: string) => (
    <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: colors.get(key) ?? OTHER_COLOR }} />
  )

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <RangePicker preset={preset} onPreset={id => {
          if (id === "custom") setCustom([from, to])
          setPreset(id)
        }} />
        {preset === "custom" && (
          <div className="flex items-center gap-1.5">
            <Input type="date" className="h-8 w-36 text-xs" value={custom[0]} max={custom[1]}
              onChange={e => setCustom([e.target.value, custom[1]])} aria-label="From" />
            <span className="text-xs text-muted-foreground">to</span>
            <Input type="date" className="h-8 w-36 text-xs" value={custom[1]} min={custom[0]} max={today()}
              onChange={e => setCustom([custom[0], e.target.value])} aria-label="To" />
          </div>
        )}
        {scope === "all" && <UserPicker users={users} selected={selected} onSelect={setUser} />}
        <RefreshButton refreshing={loading} onClick={() => setReload(n => n + 1)} title="Refresh" className="ml-auto" />
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
      {!validRange && (
        <div className="rounded-lg border px-3 py-2 text-xs text-muted-foreground">
          Pick a start date on or before the end date.
        </div>
      )}

      <div className={cn("flex flex-col gap-5 transition-opacity", loading && data && "opacity-60")}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Total tokens" value={totalTokens(totals)} hero />
          {TOKEN_KINDS.map(k => <Stat key={k.key} label={k.label} value={totals[k.key]} />)}
          <Stat label="Requests" value={totals.requests} />
        </div>

        <section className="rounded-lg border p-4">
          <div className="mb-3 flex items-center gap-2">
            <h2 className="flex-1 text-sm font-medium">
              Tokens per {data?.bucket ?? bucket}{selected ? ` · ${selected.label}` : ""}
            </h2>
            <Tabs value={bucket} onValueChange={v => setBucket(v as Bucket)}>
              <TabsList>
                <TabsTrigger value="day" className="px-2.5 text-xs">Day</TabsTrigger>
                <TabsTrigger value="week" className="px-2.5 text-xs">Week</TabsTrigger>
                <TabsTrigger value="month" className="px-2.5 text-xs">Month</TabsTrigger>
              </TabsList>
            </Tabs>
            <Tabs value={stack} onValueChange={v => setStackBy(v as Stack)}>
              <TabsList>
                {stacks.filter(s => !(selected && s === "user")).map(s => (
                  <TabsTrigger key={s} value={s} className="px-2.5 text-xs">{STACK_LABELS[s]}</TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
          {!chart ? (
            <div className="flex h-64 items-center justify-center text-muted-foreground">
              {loading && <Loader2 className="size-5 animate-spin" />}
            </div>
          ) : (
            <UsageChart {...chart} />
          )}
        </section>

        {scope === "all" && (
          <UsageTable
            title="By user"
            groups={users}
            selected={selected?.key ?? null}
            onSelect={key => setUser(key === user ? null : key)}
            lead={g => (
              <span className="flex items-center gap-2 whitespace-nowrap">
                {stack === "user" && swatch(userColors, g.key)}
                {g.key === "unknown"
                  ? <span className="italic text-muted-foreground">{g.label}</span>
                  : <><UserAvatar username={g.label} className="size-5 text-[10px]" /><span className="truncate">{g.label}</span></>}
              </span>
            )}
          />
        )}
        <UsageTable
          title="By model"
          groups={models}
          lead={g => (
            <span className="flex items-center gap-2 whitespace-nowrap">
              {stack === "model" && swatch(modelColors, g.key)}
              <span className="truncate font-mono text-xs">{g.label}</span>
            </span>
          )}
        />
      </div>
    </div>
  )
}

// Presets as one segmented row; Custom reveals the date inputs.
function RangePicker({ preset, onPreset }: { preset: string; onPreset: (id: string) => void }) {
  return (
    <Tabs value={preset} onValueChange={v => onPreset(v as string)}>
      <TabsList>
        {RANGE_PRESETS.map(p => (
          <TabsTrigger key={p.id} value={p.id} className="px-2.5 text-xs">{p.label}</TabsTrigger>
        ))}
        <TabsTrigger value="custom" className="px-2.5 text-xs">Custom</TabsTrigger>
      </TabsList>
    </Tabs>
  )
}

function UserPicker({ users, selected, onSelect }: {
  users: Group[]
  selected: Group | null
  onSelect: (key: string | null) => void
}) {
  return (
    <div className="flex items-center">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="outline" size="sm" className={cn("gap-1.5 text-xs", selected && "rounded-r-none")} />}
        >
          <Users className="size-3.5 text-muted-foreground" />
          {selected?.label ?? "All users"}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-72 w-48">
          <DropdownMenuRadioGroup value={selected?.key ?? ""} onValueChange={v => onSelect((v as string) || null)}>
            <DropdownMenuRadioItem value="" closeOnClick className="cursor-pointer text-xs">All users</DropdownMenuRadioItem>
            {users.length > 0 && <DropdownMenuSeparator />}
            {users.map(u => (
              <DropdownMenuRadioItem key={u.key} value={u.key} closeOnClick className="cursor-pointer text-xs">
                <span className="truncate">{u.label}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {selected && (
        <Button variant="outline" size="icon-sm" className="-ml-px rounded-l-none" title="All users" onClick={() => onSelect(null)}>
          <X className="size-3.5" />
        </Button>
      )}
    </div>
  )
}

function Stat({ label, value, hero }: { label: string; value: number; hero?: boolean }) {
  return (
    <div className="rounded-lg border px-3 py-2.5" title={value.toLocaleString()}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 font-semibold", hero ? "text-xl" : "text-lg")}>{formatTokens(value)}</div>
    </div>
  )
}

const COLUMNS: { key: keyof Totals; label: string }[] = [
  { key: "requests", label: "Requests" },
  ...TOKEN_KINDS.map(k => ({ key: k.key as keyof Totals, label: k.label })),
]

function UsageTable({ title, groups, lead, selected, onSelect }: {
  title: string
  groups: Group[]
  lead: (g: Group) => React.ReactNode
  selected?: string | null
  onSelect?: (key: string) => void
}) {
  const grand = totalTokens(groups.reduce<Totals>((t, g) => addTotals(t, g), emptyTotals()))
  return (
    <section className="overflow-hidden rounded-lg border">
      <h2 className="border-b bg-muted/40 px-3 py-2 text-sm font-medium">{title}</h2>
      {groups.length === 0 ? (
        <div className="px-3 py-6 text-center text-xs text-muted-foreground">No usage in this range</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="text-left">
                <th className="px-3 py-2 font-medium" />
                {COLUMNS.map(c => <th key={c.key} className="px-3 py-2 text-right font-medium">{c.label}</th>)}
                <th className="px-3 py-2 text-right font-medium">Total</th>
                <th className="w-24 px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {groups.map(g => {
                const total = totalTokens(g)
                return (
                  <tr
                    key={g.key}
                    className={cn(
                      "border-t",
                      onSelect && "cursor-pointer hover:bg-muted/40",
                      selected === g.key && "bg-muted/60 hover:bg-muted/60",
                    )}
                    onClick={onSelect ? () => onSelect(g.key) : undefined}
                  >
                    <td className="max-w-56 truncate px-3 py-2">{lead(g)}</td>
                    {COLUMNS.map(c => (
                      <td key={c.key} className="px-3 py-2 text-right tabular-nums text-muted-foreground" title={g[c.key].toLocaleString()}>
                        {formatTokens(g[c.key])}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-right font-medium tabular-nums" title={total.toLocaleString()}>
                      {formatTokens(total)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="h-1.5 rounded-full bg-muted">
                        <div className="h-full rounded-full bg-foreground/40" style={{ width: `${grand ? (total / grand) * 100 : 0}%` }} />
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
