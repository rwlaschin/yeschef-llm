import { onMounted, onBeforeUnmount } from 'vue'

/**
 * Poll `fn` every `intervalMs`, starting on mount and STOPPING on unmount.
 *
 * Two guarantees the bare `setInterval` pattern didn't give us:
 *  1. Self-cancels on unmount — no leaked timers firing slow `$fetch`es after
 *     you've navigated away (that congestion is what made fast nav land on a
 *     stale route in dev).
 *  2. Non-overlapping — schedules the NEXT run only after the current one
 *     settles, so a slow call (e.g. /api/health pinging four backends) can't
 *     stack requests on top of itself.
 *
 * Runs client-side only (no point polling during SSR).
 */
export const usePoll = (fn: () => any, intervalMs: number) => {
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const tick = async () => {
    if (stopped) return
    try {
      await fn()
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs)
    }
  }

  onMounted(() => {
    stopped = false
    tick()
  })

  onBeforeUnmount(() => {
    stopped = true
    if (timer) clearTimeout(timer)
  })
}
