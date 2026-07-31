import pino from "pino";

let logger: ReturnType<typeof pino> | null = null;

// localStorage fires `storage` only in OTHER tabs, so a same-tab write is invisible to listeners.
// The transport announces writes on this event instead — that is what lets the viewer drop polling.
const LOCAL_LOG_EVENT = "yeschef-llm-logs:written";

export const useLogger = (name: string) => {
  if (process.server) {
    return {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
    };
  }

  if (!logger) {
    // Custom localStorage transport for Pino
    const localStorageTransport = {
      write(chunk: string) {
        try {
          const logs = JSON.parse(
            localStorage.getItem("yeschef-llm-logs") || "[]"
          );
          const log = JSON.parse(chunk);
          logs.push({
            ...log,
            timestamp: new Date().toISOString(),
          });

          // Keep only last 100 logs
          if (logs.length > 100) {
            logs.shift();
          }

          localStorage.setItem("yeschef-llm-logs", JSON.stringify(logs));
          window.dispatchEvent(new CustomEvent(LOCAL_LOG_EVENT));
        } catch (err) {
          console.error("Failed to write to localStorage:", err);
        }
      },
    };

    logger = pino(
      {
        level: "info",
        base: { module: name },
        transport: {
          target: "pino/browser",
          options: {
            write: localStorageTransport.write,
          },
        },
      }
    );
  }

  return logger.child({ module: name });
};


// ── logd: the local dev log collector (tools/logd in yeschef-orders) ─────────────────────────
// Keeps a per-component ring buffer ON DISK, so unlike the localStorage source above it survives
// a page reload, a dev-server crash, and its own restart. Not running is a normal state — the
// picker falls back to this dashboard's own logs and nothing errors.
//
// Nothing here polls. Backfill once over HTTP, then SSE carries every subsequent line; logd also
// pushes a frame when a new component appears, so the source list stays current on its own.
const LOGD_URL = "http://localhost:4319";
export const LOCAL_SOURCE = "dashboard";
export const ALL_SOURCE = "All";

// logd levels are strings; the viewer speaks pino's numeric levels.
const LEVEL_NUM: Record<string, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const MAX_LINES = 1000;   // ring the client holds; unbounded growth would sink the page

export interface LogLine {
  level: number;
  timestamp: string;
  msg: string;      // escape-free — what search and filtering run against
  raw?: string;     // original terminal output, colour codes intact — what the viewer renders
  module: string;
  seq: number;      // stable identity, so v-for keys don't churn as the window slides
}

let localSeq = 0;
const toLine = (l: any, component: string): LogLine => ({
  level: LEVEL_NUM[l.level] ?? 30,
  timestamp: new Date(l.ts).toISOString(),
  msg: l.msg,
  raw: l.raw,
  module: l.component || component,
  seq: l.seq ?? ++localSeq,
});

/** Every selectable source: All, this dashboard, then each component logd is collecting. */
export const useLogdSources = () => {
  const sources = ref<string[]>([ALL_SOURCE, LOCAL_SOURCE]);
  const known = ref<string[]>([]);
  let es: EventSource | null = null;

  const rebuild = () => {
    sources.value = [ALL_SOURCE, LOCAL_SOURCE, ...[...new Set(known.value)].sort()];
  };

  const load = async () => {
    try {
      const res = await fetch(`${LOGD_URL}/components`);
      const { components } = await res.json();
      known.value = components.map((c: any) => c.component);
    } catch {
      known.value = [];   // collector down — degrade quietly
    }
    rebuild();
  };

  onMounted(() => {
    load();
    // EventSource reconnects by itself, so a logd restart re-attaches with no help from us.
    es = new EventSource(`${LOGD_URL}/stream`);
    es.onmessage = (e) => {
      const { component } = JSON.parse(e.data);
      if (component && !known.value.includes(component)) {
        known.value = [...known.value, component];
        rebuild();
      }
    };
  });
  onBeforeUnmount(() => es?.close());

  return { sources, reload: load };
};

/** Logs for the selected source: ALL_SOURCE, LOCAL_SOURCE, or a logd component name. */
export const useLogs = (source: Ref<string>) => {
  // shallowRef: the array is replaced wholesale on each flush, and Vue must NOT walk thousands of
  // line objects making them deeply reactive — that alone was a large part of the cost.
  const logs = shallowRef<LogLine[]>([]);
  const connected = ref(false);
  let es: EventSource | null = null;

  // Incoming lines are buffered and applied one frame at a time. Reacting per line meant a fresh
  // MAX_LINES array, a full re-filter and a full re-render for EVERY line — at a few hundred
  // lines/sec (turbopack + emulator chatter) that saturates the main thread and locks the tab.
  let pending: LogLine[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  const FLUSH_MS = 250;

  const flush = () => {
    if (!pending.length) return;
    const next = logs.value.concat(pending);
    pending = [];
    logs.value = next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
  };

  const startFlushing = () => { if (!timer) timer = setInterval(flush, FLUSH_MS); };
  const stopFlushing = () => { if (timer) { clearInterval(timer); timer = null; } pending = []; };

  const stop = () => { es?.close(); es = null; connected.value = false; stopFlushing(); };

  const loadLocal = () => {
    try {
      const stored = localStorage.getItem("yeschef-llm-logs");
      logs.value = stored ? JSON.parse(stored) : [];
    } catch (err) {
      console.error("Failed to load logs:", err);
    }
  };

  const subscribe = (path: string, component: string) => {
    stop();
    es = new EventSource(`${LOGD_URL}${path}`);
    es.onopen = () => { connected.value = true; };
    es.onerror = () => { connected.value = false; };   // EventSource retries on its own
    es.onmessage = (e) => {
      pending.push(toLine(JSON.parse(e.data), component));
      // Hard cap the buffer too: a burst between frames must not grow without bound.
      if (pending.length > MAX_LINES) pending = pending.slice(-MAX_LINES);
    };
    startFlushing();
  };

  const load = async () => {
    const s = source.value;
    if (s === LOCAL_SOURCE) { stop(); return loadLocal(); }
    const isAll = s === ALL_SOURCE;
    try {
      const res = await fetch(`${LOGD_URL}${isAll ? `/logs-all?n=${MAX_LINES}` : `/logs/${s}?n=${MAX_LINES}`}`);
      const { lines } = await res.json();
      logs.value = lines.map((l: any) => toLine(l, s));      // backfill first…
    } catch {
      logs.value = [];
    }
    subscribe(isAll ? "/stream-all" : `/stream/${s}`, s);     // …then stream the tail
  };

  const clearLogs = async () => {
    const s = source.value;
    if (s === LOCAL_SOURCE) {
      localStorage.removeItem("yeschef-llm-logs");
    } else if (s !== ALL_SOURCE) {
      await fetch(`${LOGD_URL}/logs/${s}`, { method: "DELETE" }).catch(() => {});
    }
    logs.value = [];   // ALL clears the view only — it must not wipe every component's history
  };

  // Same-tab localStorage writes fire no `storage` event, so the transport announces its own.
  const onLocalWrite = () => { if (source.value === LOCAL_SOURCE) loadLocal(); };

  onMounted(() => {
    load();
    window.addEventListener(LOCAL_LOG_EVENT, onLocalWrite);
    window.addEventListener("storage", onLocalWrite);   // other tabs
  });
  onBeforeUnmount(() => {
    stop();
    window.removeEventListener(LOCAL_LOG_EVENT, onLocalWrite);
    window.removeEventListener("storage", onLocalWrite);
  });
  watch(source, load);

  return { logs, clearLogs, reload: load, connected };
};
