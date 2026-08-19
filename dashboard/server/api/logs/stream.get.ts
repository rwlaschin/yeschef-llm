// Event-based log delivery: the client holds one EventSource; new lines are pushed as
// SSE messages. Cloud Logging has no push channel, so this bridge re-reads the REST API
// (in-process HTTP via /api/logs/cloud — no child processes) while, and only while, a
// stream is open. The client never polls.
const READ_MS = 15000

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const stream = createEventStream(event)
  const seen = new Set<string>()
  let since = new Date(Date.now() - 6 * 3600_000).toISOString()
  let reading = false

  const read = async () => {
    if (reading) return
    reading = true
    try {
      const res = await $fetch<any>('/api/logs/cloud', {
        query: { env: q.env, n: q.n || 150, filter: q.filter, since },
      })
      if (res?.error) { await stream.push(JSON.stringify({ error: res.error })); return }
      const fresh = (res?.lines ?? []).filter((l: any) => l.id && !seen.has(l.id))
      if (!fresh.length) return
      fresh.forEach((l: any) => seen.add(l.id))
      // Overlap the anchor by a second so a same-timestamp line can't be skipped; `seen` dedupes.
      since = new Date(new Date(fresh[fresh.length - 1].ts).getTime() - 1000).toISOString()
      await stream.push(JSON.stringify({ lines: fresh }))
    } catch { /* transient read failure — next tick retries */ }
    finally { reading = false }
  }

  const timer = setInterval(read, READ_MS)
  read()
  stream.onClosed(() => clearInterval(timer))
  return stream.send()
})
