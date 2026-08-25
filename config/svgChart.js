// LLM-AUTHORED CHARTS: the model's answer IS the SVG. One string, stored as-is, rendered as-is.
//
// The whole contract is "one self-contained <svg> document". That single decision buys everything
// asked of it: it is a DB column (a string), it is a downloadable .svg, and it is interactive —
// because an SVG document may carry its own <script>, which runs both when the file is opened
// directly and when the markup is inlined into a page. No iframe, no wrapper, no renderer that has
// to understand what the chart means.
//
// The cost is unavoidable and worth naming plainly: this executes MODEL-WRITTEN JAVASCRIPT in the
// page that displays it. There is no sandbox left once the iframe is off the table, so the guard is
// validateSvgChart() below — an allowlist on what the markup may contain, applied BEFORE the string
// is stored and again before it is rendered. It is a narrower guarantee than an iframe: it stops the
// chart from phoning home or loading anything external, it does NOT stop badly-written script from
// misbehaving inside the page. Anything that fails is rejected outright and shown as a failure,
// never rendered "mostly".

// Hard ceiling on a stored chart. A 200KB blob of model output in a Firestore doc is a bug, not a
// chart; the real ones measured here run 1.5–6KB.
export const MAX_SVG_BYTES = 64 * 1024;

// Everything that would let a chart reach off the page or out of its own document. Checked as plain
// substrings on the whole answer — deliberately blunt: a chart has no legitimate reason to name any
// of these, so a false positive costs one regeneration and a false negative costs a lot more.
const FORBIDDEN = [
  // network. NOT a scan for "http" — see EXTERNAL_REF below; the SVG namespace is an http URI that
  // is never fetched, and forbidding the string forbids every valid document.
  "fetch(", "XMLHttpRequest", "WebSocket", "EventSource", "navigator.sendBeacon", "import(", "@import",
  // escaping the document
  "window.parent", "window.top", "window.opener", "document.cookie", "localStorage",
  "sessionStorage", "indexedDB", "document.write", "location =", "location.href",
  // dynamic code
  "eval(", "new Function", "setTimeout(\"", "setInterval(\"",
  // things that are not a chart
  "<iframe", "<object", "<embed", "<foreignObject", "<image", "<use ",
];

// A SHORTFALL is a legitimate answer, not a failure: the form the reader named needs a shape of data
// the request does not carry, so the step says what is missing instead of inventing a dimension or
// substituting a chart nobody asked for. It is words by design, so it must never be run through the
// chart gate — "no <svg> document" would report the pipeline's most useful answer as a defect.
const SHORTFALL = /^\s*NEEDS DATA:/i;
const REFUSAL = /^\s*CANNOT ANSWER\s*$/i;

/** The reader-facing shortfall message, or null. Non-null means "no chart, and that is the answer". */
export function shortfallOf(text) {
  const body = String(text ?? "").trim();
  return SHORTFALL.test(body) ? body : null;
}

/** True when the answer declines outright: not a request for a drawing at all. */
export const isRefusal = (text) => REFUSAL.test(String(text ?? "").trim());

/** The <svg> document out of a model answer — strips any prose or fence around it. Null if absent. */
export function extractSvg(text) {
  const body = String(text ?? "");
  const start = body.indexOf("<svg");
  const end = body.lastIndexOf("</svg>");
  return start >= 0 && end > start ? body.slice(start, end + 6) : null;
}

/**
 * Reasons this document is UNSAFE to store and inject — [] means safe. A SANITIZER, not a critic:
 * every rule here is about what the script may reach, never about whether the chart is any good.
 *
 * Whether the chart is correct — right form, axes present, a control that actually redraws — is the
 * `chart_check` STEP's job, judged by a model against stated Pass/Fail criteria and reported through
 * the `@@::PASS::@@` marker like every other step in the pipeline (docs/design/prompt-library.md
 * rule 3: the producer is never its own judge). Grading output quality with regexes here was the
 * wrong place for it; a step whose answer executes in our page still needs a boundary that a model's
 * own PASS cannot wave through, and that is all this function is.
 */
export function unsafeSvgReasons(text) {
  const svg = extractSvg(text);
  if (!svg) return ["no <svg> document in the answer"];
  const e = [];

  // TextEncoder, not Buffer: this module is imported by the DASHBOARD (#svg-chart) as well as the
  // worker, and `Buffer` is Node-only — using it threw mid-render and blanked the whole results panel.
  const bytes = new TextEncoder().encode(svg).length;
  if (bytes > MAX_SVG_BYTES) e.push(`chart is ${(bytes / 1024).toFixed(0)}KB, over the ${MAX_SVG_BYTES / 1024}KB limit`);

  // The xmlns is the difference between a document and a fragment: without it the stored string will
  // not open as a .svg, and an unnamespaced blob injected into the page is not an SVG at all.
  // `xmlns=` is matched loosely so a single-quoted namespace is not a miss.
  if (!/xmlns=['"]http:\/\/www\.w3\.org\/2000\/svg['"]/.test(svg)) e.push("missing the SVG namespace");

  const lower = svg.toLowerCase();
  for (const bad of FORBIDDEN) if (lower.includes(bad.toLowerCase())) e.push(`contains forbidden "${bad}"`);

  // A document only reaches the network through an ATTRIBUTE that fetches. `xmlns` is not one of
  // them — it is an identifier, never resolved — so it is simply not in this list.
  for (const m of svg.matchAll(/\b(src|href|xlink:href|data|poster|filter|mask|clip-path)\s*=\s*["']([^"']*)["']/gi)) {
    const [, attr, value] = m;
    // Same-document references (#id) are how a filter or a gradient is used at all. Anything else
    // leaves the file, which a self-contained chart never needs to do.
    if (!value.startsWith("#") && !/^(?:none|url\(#)/i.test(value)) e.push(`${attr} points outside the document: "${value.slice(0, 60)}"`);
  }

  return e;
}

/** Does this answer carry a chart at all? Cheap check for "should I even try to render this". */
export const looksLikeSvgChart = (text) => extractSvg(text) !== null;

// The step INSTRUCTIONS: MARKERS AND THE REQUEST, AND NOTHING ELSE.
//
// docs/design/prompt-library.md rule 1 — "Zero prompts in code. All LLM/AI prompts live in Mongo
// `prompt_library` … never hardcoded in worker/** or functions/**". Every word the model reads about
// how to build a chart is a `prompt_library` fragment mapped to `analytics_widget`, scoped
// `task_list`, substituted into these markers at send time (worker/steps/step.js →
// config/promptSections.js assembleFor). scripts/seed-svg-chart-prompts.mjs is the checked-in source
// of those fragments; the Prompt Library page tunes them without a deploy.
//
// The hard limits are a fragment too, even though validateSvgChart() is what enforces them — a
// second copy in code would be a prompt in code, and the drift it protects against is caught by
// scripts/seed-svg-chart-prompts.test.js instead, which asserts the fragment names every constant
// the validator checks.
export const svgChartInstructions = (question) => `{leading}

{trailing}

{conditions}

{fail}

# THE REQUEST

${question}`;
