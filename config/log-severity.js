// Cloud Logging severity for the GPU worker.
//
// The worker runs on a COS GCE VM, where the ops agent folds container stdout AND stderr into one
// stream and stamps every entry INFO unless the payload is JSON carrying a `severity` key. So a
// console.error("… failed …") arrived as INF with the word "Error" in the text — indistinguishable
// from a normal log, which made real failures invisible in the console and unusable for alerting.
// (Cloud Run maps stderr→ERROR by itself; only the GCE worker needs this.)
//
// Installed as a console shim rather than 13 call-site edits so that future console.error/warn calls
// are covered automatically and nobody has to remember a logging helper.
const SEVERITY = { error: "ERROR", warn: "WARNING" };

// Locally the only consumer is logd, which reads a three-letter head token and would otherwise store
// and display the JSON wrapper itself as the log line. Cloud Logging is the only reason the wrapper
// exists, so dev emits the token and production is untouched.
// Opt IN to plain text, never out of JSON: the deployed worker runs with NODE_ENV unset (deploy.js's
// `docker run` passes no NODE_ENV and the image sets none), so a `!== "production"` test would strip
// severity in production — the one place it is load-bearing.
const DEV = /^dev/i.test(process.env.NODE_ENV || "");
const TOKEN = { error: "ERR", warn: "WRN" };
// logd splits a batch on newlines and reads the token at the START of each physical line, so a stack
// has to carry it on every line or only the first row is marked.
const tokenize = (tok, s) => String(s).split("\n").map((l) => `${tok} ${l}`).join("\n");

// Multi-line strings (notably a stack) must stay in ONE entry: the agent splits a plain multi-line
// write into an entry per line, which is why a SIGTERM stack print showed up as a bare "Error" row
// that read like a crash.
const render = (a) =>
  a instanceof Error ? (a.stack || a.message)
  : typeof a === "string" ? a
  : (() => { try { return JSON.stringify(a); } catch { return String(a); } })();

export function installSeverityLogging(console_ = console) {
  for (const [method, severity] of Object.entries(SEVERITY)) {
    const original = console_[method].bind(console_);
    console_[method] = (...args) => {
      const message = args.map(render).join(" ");
      // Already-structured payloads keep their own fields; just ensure a severity is present.
      if (args.length === 1 && typeof args[0] === "string" && args[0].startsWith("{")) {
        try {
          const parsed = JSON.parse(args[0]);
          if (parsed && typeof parsed === "object") {
            return original(JSON.stringify({ severity, ...parsed }));
          }
        } catch { /* not JSON after all — fall through to the plain wrap */ }
      }
      original(DEV ? tokenize(TOKEN[method], message) : JSON.stringify({ severity, message }));
    };
  }
}
