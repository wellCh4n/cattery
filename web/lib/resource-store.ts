import { create } from "zustand"

export interface Resource<T> {
  data?: T
  loading: boolean
  stale: boolean
  error: string | null
}
interface Resources<T> {
  entries: Record<string, Resource<T>>
  load: (key: string, force?: boolean) => Promise<T | null>
  invalidate: (key: string) => Promise<T | null>
  drop: (key: string) => void
  reset: () => void
}

// Coalesce readers, discard superseded responses, and replay invalidation that
// arrives during a request. Failed refreshes retain the last successful data.
export function createResourceStore<T>(fetcher: (key: string) => Promise<T>) {
  type Request = { revision: number; promise: Promise<T | null> }
  const requests = new Map<string, Request>()
  let epoch = 0
  return create<Resources<T>>((set, get) => ({
    entries: {},
    load: (key, force = false) => {
      const pending = requests.get(key)
      if (pending) {
        if (force) pending.revision++
        return pending.promise
      }
      const cached = get().entries[key]
      if (!force && cached?.data !== undefined && !cached.stale) return Promise.resolve(cached.data)
      const startedEpoch = epoch
      const request: Request = { revision: 0, promise: Promise.resolve(null) }
      requests.set(key, request)
      set(state => ({ entries: { ...state.entries, [key]: { ...cached, loading: true, stale: true, error: null } } }))
      request.promise = Promise.resolve().then(async () => {
        while (startedEpoch === epoch && requests.get(key) === request) {
          const revision = request.revision
          try {
            const data = await fetcher(key)
            if (startedEpoch !== epoch || requests.get(key) !== request) return null
            if (revision !== request.revision) continue
            set(state => ({ entries: { ...state.entries, [key]: { data, loading: false, stale: false, error: null } } }))
            return data
          } catch (error) {
            if (startedEpoch !== epoch || requests.get(key) !== request) return null
            if (revision !== request.revision) continue
            set(state => ({ entries: { ...state.entries, [key]: {
              ...state.entries[key], loading: false, stale: true,
              error: error instanceof Error ? error.message : "Failed to load",
            } } }))
            return null
          }
        }
        return null
      }).finally(() => {
        if (requests.get(key) === request) requests.delete(key)
      })
      return request.promise
    },
    invalidate: key => get().load(key, true),
    drop: key => {
      requests.delete(key)
      set(state => {
        const entries = { ...state.entries }
        delete entries[key]
        return { entries }
      })
    },
    reset: () => {
      epoch++
      requests.clear()
      set({ entries: {} })
    },
  }))
}
