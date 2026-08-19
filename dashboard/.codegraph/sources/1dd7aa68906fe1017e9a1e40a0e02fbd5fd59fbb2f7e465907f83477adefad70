// Production writes to stdout, which lands in Cloud Logging — logd never sees it, so without this
// route prod is simply invisible in the viewer. Server-side only: ADC credentials must never reach
// the browser.

// The viewer speaks pino's numeric levels. DEFAULT means "severity unspecified", which is what plain
// stdout produces — treat it as info rather than hiding the bulk of prod output below the INF filter.
const SEVERITY_LEVEL: Record<string, number> = {
  DEFAULT: 30, DEBUG: 20, INFO: 30, NOTICE: 30,
  WARNING: 40, ERROR: 50, CRITICAL: 60, ALERT: 60, EMERGENCY: 60,
}

// GCE hands every line of startup-script/serial stdout to Cloud Logging as severity INFO (often
// DEFAULT), so a bash `warning:` or a failed install step arrives indistinguishable from progress
// output and lands under the INF filter. Classify from the text, but only ever UPWARDS and only when
// the record's own severity was unspecified — an explicit WARNING/ERROR is authoritative.
const ERR_TEXT = /\b(error|fatal|failed|failure|cannot|denied|refused|traceback|panic|exhausted)\b|\bexit code [1-9]/i
const WRN_TEXT = /\b(warn|warning|deprecat|retrying|timed out|timeout|skipping)\b/i

const textLevel = (severity: number, text: string) => {
  if (severity > 30) return severity
  if (ERR_TEXT.test(text)) return 50
  if (WRN_TEXT.test(text)) return 40
  return severity
}

// GCE serial-console output reaches Cloud Logging with its escapes already stringified — the payload
// holds the four characters \x1b, not an ESC byte, plus literal \r\n. The viewer's ansiHtml only matches
// real ESC, so those lines printed their own colour codes: `[\x1b[0;32m  OK  \x1b[0m] Reached target…`.
// Decode them back into control characters here, at the one point that knows the payload came from
// Cloud Logging; ansiHtml then colours the line exactly like a local terminal line.
const ESC = String.fromCharCode(27)
const decodeEscapes = (s: string) => {
  // EVERY \xNN, not just \x1b: the same stringifying turns non-ASCII into its raw UTF-8 bytes, so a
  // single `…` arrives as `\xe2\x80\xa6` and a container id as `\x36\x31\x38…`. Decoding each escape
  // gives one char per BYTE, which then has to be re-read as UTF-8 or multi-byte characters stay
  // mojibake. Skipped when the text already holds real non-Latin-1 characters, because latin1 round-
  // tripping those would corrupt them.
  // Decoded a RUN at a time, not per escape and not over the whole string. A run is one UTF-8
  // character's bytes, so it must be decoded together (\xe2\x80\xa6 is one ellipsis, not three chars).
  // Re-decoding the finished string instead would corrupt text that legitimately holds a Latin-1
  // character — the `·` in our own `[capacity] … · us-central1` lines turned into a replacement char.
  return s
    .replace(/(?:\\x[0-9a-fA-F]{2})+/g, (run) =>
      Buffer.from((run.match(/[0-9a-fA-F]{2}/g) ?? []).map((h) => parseInt(h, 16))).toString('utf8'))
    .replace(/\\u001b|\\033|\\e/g, ESC)
    .replace(/\\r\\n|\\r|\\n/g, '\n')
    .replace(/\\t/g, '\t')
}

// `msg` is what search and filtering run against, so it must stay escape-free — ansiHtml renders `raw`.
// Not just SGR: serial output also carries cursor/erase sequences, and leaving those in meant a search
// for a word beside one silently failed to match. Built from ESC rather than typed as a literal control
// character, which is unreadable in an editor and unmatchable by a text edit.
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}[@-Z\\\\-_]`, "g")
const stripAnsi = (s: string) => s.replace(ANSI_RE, "")

// Cloud Run access logs carry NO payload at all — the whole record is `httpRequest`, so every payload
// fallback misses and the row renders as a bare `{}`. These are also most of the WARNING/ERROR volume
// (a 4xx/5xx response is logged at that severity), which made the ERR view a wall of empty lines.
const httpLine = (r: any) =>
  r?.requestMethod || r?.requestUrl || r?.status
    ? `${r.requestMethod ?? '?'} ${String(r.requestUrl ?? '').replace(/^https?:\/\/[^/]+/, '') || '/'}`
      + ` → ${r.status ?? '-'}${r.latency ? ` (${r.latency})` : ''}`
    : undefined

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const projectId = q.env === 'production'
    ? process.env.GCP_PROJECT_ID_PROD || process.env.GCP_PROJECT_ID
    : process.env.GCP_PROJECT_ID
  if (!projectId) return { lines: [], count: 0, error: 'GCP_PROJECT_ID not configured' }

  const n = Math.min(Number(q.n) || 200, 1000)
  // Cloud Logging has no push channel, so the client polls and anchors each poll on the newest line
  // it already holds. Reads are quota-limited per minute, so an unbounded scan is not an option —
  // first load takes a short window instead.
  const since = String(q.since || new Date(Date.now() - 6 * 3600_000).toISOString())
  const filter = [`timestamp>"${since}"`, String(q.filter || '')].filter(Boolean).join(' ')

  try {
    const { GoogleAuth } = await import('google-auth-library')
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/logging.read'] })
    const token = await (await auth.getClient()).getAccessToken()
    const res = await $fetch<any>('https://logging.googleapis.com/v2/entries:list', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.token}` },
      body: { resourceNames: [`projects/${projectId}`], filter, orderBy: 'timestamp desc', pageSize: n },
      timeout: 15000,
    })

    const lines = (res?.entries ?? []).map((e: any) => {
      // Our structured lines put the human text in jsonPayload.message; worker lines carry an
      // instance name instead, and GCE activity entries carry neither — only a protoPayload whose
      // methodName IS the event. Fall through all of those before dumping the raw payload.
      const raw = decodeEscapes(String(
        e.textPayload ?? e.jsonPayload?.message ?? e.jsonPayload?.instance?.name
        ?? e.protoPayload?.status?.message ?? e.protoPayload?.methodName
        ?? httpLine(e.httpRequest)
        ?? JSON.stringify(e.jsonPayload ?? e.protoPayload ?? {}),
      )).trimEnd()
      const msg = stripAnsi(raw)
      return {
      id: e.insertId,                       // stable identity — the client dedupes overlapping polls on it
      ts: e.timestamp,
      level: textLevel(SEVERITY_LEVEL[e.severity] ?? 30, msg),
      msg,
      raw,
      module: e.resource?.labels?.service_name || e.resource?.type || 'gcp',
      }
    }).reverse()                            // oldest-first, the order the viewer's ring appends in

    return { lines, count: lines.length }
  } catch (e: any) {
    // Read quota is the common failure; surface it as an empty page with a reason rather than 500ing
    // the viewer, which would also kill the logd sources sharing the panel.
    return { lines: [], count: 0, error: e?.data?.error?.message || e.message || 'Cloud Logging read failed' }
  }
})
