// ============================================================
// Single source of truth for LLM models, topics, and subscriptions.
//
// Imported by pubsub/setup.js, scripts/dev.js, scripts/deploy.js, and the
// dashboard. Pure data + helpers — no dependencies — so it's safe to import
// from node scripts AND Nuxt/Nitro server routes.
//
// Add or rename a model HERE only; everything else derives from it.
//
// `topic` is the canonical version-based id for a tier — it names the model that
// actually runs (e.g. llama3_1_8b_v1), so every derived name carries the version.
// There is NO short nickname/key: a name like "slim-dev" hides which model is live
// (and once hid a tier silently running the wrong model). Names tell the truth instead.
//
// Conventions (derived, never hand-written elsewhere):
//   subscription  = sub_<topic>             e.g. sub_llama3_1_8b_v1
//   dead-letter   = dead_letter_<topic>     e.g. dead_letter_llama3_1_8b_v1
//   version slug  = <topic with _ → ->      e.g. llama3-1-8b-v1   (GCE/Docker-name safe: no underscores)
//   image name    = ollama-<slug>           e.g. ollama-llama3-1-8b-v1
//   dev container = yeschef-worker-<slug>   e.g. yeschef-worker-llama3-1-8b-v1
//
// Per-model fields:
//   ctx = the model's MAX supported context window, in tokens (e.g. 131072 = 128K).
//         It's the capability ceiling, not necessarily the runtime value — a query may
//         set Ollama's num_ctx LOWER to fit a memory/latency budget (a long context grows
//         the KV cache: a 12B at 256K needs ~24GB+, far past a 16GB box).
// ============================================================

export const MODELS = [
  // Llama dev tier — Llama 3.1 8B (`llama3.1:8b`, ~5GB Q4). It's the largest *modern* Llama
  // that fits a 16–20GB budget: the dense family jumps 8B → 70B with nothing in between, and
  // the smallest 70B quant (q2_K) is 26GB — over 20GB. Strong reasoning, fits any dev box; gpu:1.
  { label: "Llama 3.1 8B",  model: "llama3.1:8b",                  topic: "llama3_1_8b_v1",  ctx: 131072, gpu: 1, dev: true  },
  { label: "Llama 3.3 70B", model: "llama3.3:70b-instruct-q4_K_M", topic: "llama3_3_70b_v1", ctx: 131072, gpu: 2, dev: false }, // 2× L4 — no dev GPU
  // Gemma 4 12B — Google's encoder-free multimodal model built for agentic workflows.
  // Use the QAT (quantization-aware trained) tag `gemma4:12b-it-qat`: it cuts the memory
  // footprint and runs faster on every backend (Apple/AMD/Intel/NVIDIA/Qualcomm) at nearly
  // the full-precision quality — the right pick for the 16GB-laptop/dev target. Dev-capable;
  // in prod one L4 (24GB) hosts it with room for context. Tool-calling is first-class, so it
  // runs the RAW worker path (chatWithTools) — web_search/web_fetch come free, no gateway.
  { label: "Gemma 4 12B",   model: "gemma4:12b-it-qat",             topic: "gemma4_12b_v1",  ctx: 262144, gpu: 1, dev: true  },
  // Qwen 3.5 9B — Alibaba's Mar-2026 small model: vision + tools, 256K context, "thinking"
  // mode. `qwen3.5:9b` is a 6.6GB Q4 pull, so it fits a 16GB box with room to spare and runs
  // on the gpu:1 dev tier. Tool-calling is native → raw worker path (chatWithTools), no gateway.
  { label: "Qwen 3.5 9B",   model: "qwen3.5:9b",                    topic: "qwen3_5_9b_v1",  ctx: 262144, gpu: 1, dev: true  },
  // ── OpenClaw gateway tiers ──────────────────────────────────────────────────
  // OpenClaw is NOT a pullable model — it's a gateway (`ollama launch openclaw
  // --model <backing>`, https://docs.ollama.com/integrations/openclaw) that fronts a
  // REAL model and adds tools. It can front ANY Ollama model, so we expose
  // OpenClaw-wrapped variants of gemma4 + both Llamas.
  //   - Backing MUST be LOCAL: cloud :cloud tags are out (data protection + per-token cost).
  //   - `tools` = gateway tools enabled (web_search, web_fetch to start).
  //   - `gateway: "openclaw"` flags that the worker launches the OpenClaw gateway instead
  //     of plain `ollama serve` (web search). That start.sh wiring is pending — until
  //     then these run as their raw backing model.
  //   - dev = the gpu:1 tiers (slim + these two small ones); the 70B (gpu:2) tiers need
  //     2× L4 so they're prod-only.
  //   - Topics are openclaw_<backing>_v1; pubsub setup creates the new subs from this list.
  { label: "OpenClaw (Gemma 4 12B)",   model: "gemma4:12b-it-qat",            topic: "openclaw_gemma4_12b_v1",   ctx: 262144, gpu: 1, dev: true,  gateway: "openclaw", tools: ["web_search", "web_fetch"] },
  { label: "OpenClaw (Llama 3.1 8B)",  model: "llama3.1:8b",                  topic: "openclaw_llama3_1_8b_v1",  ctx: 131072, gpu: 1, dev: true,  gateway: "openclaw", tools: ["web_search", "web_fetch"] },
  { label: "OpenClaw (Llama 3.3 70B)", model: "llama3.3:70b-instruct-q4_K_M", topic: "openclaw_llama3_3_70b_v1", ctx: 131072, gpu: 2, dev: false, gateway: "openclaw", tools: ["web_search", "web_fetch"] },
];

export const subscriptionOf = (m) => `sub_${m.topic}`;
export const deadLetterOf   = (m) => `dead_letter_${m.topic}`;

// Fake/canned transport. When a job carries `fake:true`, the orchestrator dispatches
// steps to THIS topic instead of the step's real model topic; the worker returns canned
// output (no Ollama) via the SAME Firestore write path. One shared topic — no per-model
// fakes, no client-side simulation, no artificial delay.
export const FAKE_TOPIC        = "fake_canned_v1";
export const FAKE_SUBSCRIPTION = `sub_${FAKE_TOPIC}`;
export const FAKE_DEAD_LETTER  = `dead_letter_${FAKE_TOPIC}`;
// Version slug = the topic made name-safe for Docker/GCE (which reject underscores):
// llama3_1_8b_v1 → llama3-1-8b-v1. Single source of truth for every infra name.
export const slugOf         = (m) => m.topic.replace(/_/g, "-");
export const imageOf        = (m) => `ollama-${slugOf(m)}`;
// Local dev worker container name (scripts/dev.js + scripts/waker.js `docker run` these).
// The dashboard health check uses it to tell whether a model is up: in dev Ollama lives
// INSIDE this container (no host port published), so "is the model reachable?" really
// means "is this container running?". (Prod VMs name the container `worker` — see deploy.js;
// this name is dev-only, so it carries the model version, not an environment suffix.)
export const containerOf    = (m) => `yeschef-worker-${slugOf(m)}`;
export const devModels      = () => MODELS.filter((m) => m.dev);
export const byTopic        = (topic) => MODELS.find((m) => m.topic === topic);

// Subtypes the planner can assign to a step — the specialized agent kinds, each WITH a
// definition so the planner knows what it does. SINGLE SOURCE OF TRUTH: the worker (builds
// the planner's subtypes list from this), the dashboard, pubsub/scripts all read from here.
export const SUBTYPES = [
  { name: "menu_plan",   description: "Build a meal plan across the required diets, days, and meals." },
  { name: "protein_grid", description: "Assign ONE protein (type + cut) per day and mealtime for a single diet, gated by cost tier and regional availability — the protein backbone the menu is built on. Fans out one unit per diet." },
  { name: "recipes", description: "Write a reduced recipe (protein, starch, vegetable, fruit) for each day and mealtime of a single diet — the dish layer built on the protein backbone. Fans out one unit per diet." },
  { name: "nutrients", description: "Produce per-meal nutrient totals (calories, protein g, sodium mg, carbs g) for each day and mealtime of a single diet. Fans out one unit per diet." },
  { name: "recipe",      description: "Write a full recipe — ingredients and method — for a dish." },
  { name: "nutrition",   description: "Produce nutrition information for an item, recipe, or meal." },
  { name: "inventory",   description: "Determine storage, quantities, and inventory needs." },
  { name: "compliance",  description: "Check a plan or items against legal, allergen, and safety rules." },
  { name: "procurement", description: "Produce a purchasing list / order form from a plan." },
  { name: "query",       description: "Research, look up, or reason through an open question using general knowledge and web search — the general-purpose step useful for setup, defining formats, output structure, or enhancing the results of other agents." },
  { name: "task",        description: "Carry out a concrete, self-contained task and produce exactly the output the instructions describe — format, transform, draft, or assemble given content — as opposed to open-ended research (query)." },
];

// ============================================================
// Sampler parameters — Ollama `/api/chat` options the worker passes per request.
//
// SINGLE SOURCE OF TRUTH for: (1) the worker's CODE-LEVEL fallback (defaultSampler), used
// when the DB has no config or a read fails; (2) the keys the worker is ALLOWED to forward
// to Ollama (samplerKeys) — anything not listed here is never sent; (3) the dashboard's
// edit form (the `/model-config` page renders one input per entry).
//
// Only the params Ollama actually honors are listed. The newer llama.cpp samplers the model
// prints — xtc_probability, xtc_threshold, top_n_sigma, adaptive_target/decay — are NOT
// exposed through Ollama's options API, so they're deliberately omitted (sending them is a
// no-op, and listing them would imply control we don't have).
//
// `default` is Ollama's own documented default, so an unconfigured worker behaves exactly as
// before. Resolution at runtime: defaultSampler() → DB `_default` doc → DB per-model doc.
export const SAMPLER_PARAMS = [
  { key: "temperature",    label: "Temperature",      min: 0,  max: 2,         step: 0.05, default: 0.8, help: "Higher = more creative/random; lower = more focused/deterministic." },
  { key: "top_p",          label: "Top P",            min: 0,  max: 1,         step: 0.05, default: 0.9, help: "Nucleus sampling — consider tokens covering this cumulative probability." },
  { key: "top_k",          label: "Top K",            min: 0,  max: 200,       step: 1,    default: 40,  help: "Only sample from the K most likely tokens. 0 = disabled." },
  { key: "min_p",          label: "Min P",            min: 0,  max: 1,         step: 0.01, default: 0.0, help: "Drop tokens below this fraction of the top token's probability. 0 = disabled." },
  { key: "repeat_penalty", label: "Repeat penalty",   min: 0,  max: 2,         step: 0.05, default: 1.1, help: "Penalize repeats; >1 discourages repetition." },
  { key: "repeat_last_n",  label: "Repeat last N",    min: -1, max: 512,       step: 1,    default: 64,  help: "Look-back window for the repeat penalty. 0 = off, -1 = num_ctx." },
  { key: "mirostat",       label: "Mirostat",         min: 0,  max: 2,         step: 1,    default: 0,   help: "Adaptive perplexity control. 0 = off, 1 = v1, 2 = v2. Overrides top_p/top_k when on." },
  { key: "mirostat_tau",   label: "Mirostat τ (tau)", min: 0,  max: 10,        step: 0.5,  default: 5.0, help: "Target entropy — lower = more focused/coherent. Only used when mirostat ≠ 0." },
  { key: "mirostat_eta",   label: "Mirostat η (eta)", min: 0,  max: 1,         step: 0.05, default: 0.1, help: "Learning rate of the mirostat feedback loop. Only used when mirostat ≠ 0." },
  { key: "seed",           label: "Seed",             min: 0,  max: 999999999, step: 1,    default: 0,   help: "Fixed seed → reproducible output for the same prompt. 0 = random each run." },
];

// The full code-level fallback set: { temperature: 0.8, top_p: 0.9, ... }.
export const defaultSampler = () =>
  Object.fromEntries(SAMPLER_PARAMS.map((p) => [p.key, p.default]));

// Keys the worker may forward to Ollama (used to filter out anything unrecognized on save/load).
export const samplerKeys = () => SAMPLER_PARAMS.map((p) => p.key);

// ---- Output style → temperature ----------------------------------------------------------------
// A step declares the STYLE of output it produces; that maps to a temperature, overriding the
// sampler's `temperature` for that one request (the rest of the sampler is unchanged). This is the
// developit-ai pattern (context_agent ran cold ~0.1, chat_agent hot ~0.5) generalized to three
// styles — the planner/dashboard reasons about output kind, not a magic number. structured = strict
// YAML / extraction / PASS-FAIL (must not improvise); blended = structured shape with some prose;
// unstructured = conversational / free-form (the generic query).
//
// These are the CODE-LEVEL FALLBACK, same role as defaultSampler: the live values are DB-sourced
// (model_config doc `_styles`, dashboard-editable); this table is used only when that doc is missing
// or a read fails. The per-step STYLE itself is a field on the plan_library step def.
export const STYLE_TEMPS = { structured: 0.1, blended: 0.35, unstructured: 0.7 };
export const DEFAULT_STYLE = "structured"; // every pipeline step is structured unless it says otherwise

// Temperature for a step's style, given a temp map (defaults to the code fallback). Unknown/blank
// style → DEFAULT_STYLE (structured) — fail safe toward determinism, never improvisation. Returns
// null only if even the default is absent, so the caller can keep the sampler's own temperature.
export const temperatureForStyle = (style, temps = STYLE_TEMPS) =>
  temps[style] ?? temps[DEFAULT_STYLE] ?? STYLE_TEMPS[style] ?? STYLE_TEMPS[DEFAULT_STYLE] ?? null;

// Tool defs live in their OWN file (config/tools.js) — a tool is not a model. Re-exported here so
// existing `#models` / config/models.js importers keep working unchanged.
export { DEFAULT_TOOLS } from "./tools.js";

// Predetermined message/request types — the keys a prompt_library entry maps to. DERIVED
// from SUBTYPES (+ the planner) so the list lives in ONE place. `planner` is the orchestration
// brain (its PLANNER_PROMPT turns a request into the YAML step plan); the rest are the
// subtypes above. The dashboard's prompt editor offers these as a multi-select.
export const MESSAGE_TYPES = ["planner", ...SUBTYPES.map((s) => s.name)];

// ---- Run-doc id scheme (steps/ subcollection) -------------------------------
// A step's fanout units are stored as run docs whose id IS the order key: `${step}-${unit}`,
// zero-padded to a FIXED width so they sort lexicographically === numerically (Firestore sorts
// doc ids as strings, so "10" would otherwise sort before "2"). This lets the UI stream a
// VISIBLE WINDOW of units with a pure documentId() range query — no order field, and crucially
// NO composite index (Firestore always implicitly indexes __name__). Filter isDeleted client-
// side over the small window rather than in the query, so we never trip the index requirement.
//
// MAX_STEPS / MAX_UNITS are the hard ceilings — pick them generously; they only set the pad
// width. Bump them here (the single source of truth) and dispatch (writer), the worker (writer),
// and the dashboard (window range) all stay in lock-step.
export const MAX_STEPS = 1000;   // steps per plan      → step padded to 3 digits (000..999)
export const MAX_UNITS = 10000;  // fanout units / step → unit padded to 4 digits (0000..9999)

const STEP_WIDTH = String(MAX_STEPS - 1).length; // 3  (digits of the largest index, 999)
const UNIT_WIDTH = String(MAX_UNITS - 1).length; // 4  (digits of the largest index, 9999)
const pad = (n, width) => String(n).padStart(width, "0");

// The run-doc id for one fanout unit of a numeric step. e.g. unitDocId(2, 7) === "02-007".
// (The planner run, step "plan", is NOT a fanout and keeps its Pub/Sub message id.)
// Fails LOUD if step/unit exceed the pad width: an over-width index produces a longer string
// that sorts WRONG (e.g. "1000" vs "999"), silently corrupting the window ordering. Better to
// throw here than to mint a mis-sorting id — bump MAX_STEPS / MAX_UNITS if you hit this.
export const unitDocId = (step, unit) => {
  if (!Number.isInteger(step) || step < 0 || step >= MAX_STEPS) throw new Error(`step ${step} out of range [0,${MAX_STEPS})`);
  if (!Number.isInteger(unit) || unit < 0 || unit >= MAX_UNITS) throw new Error(`unit ${unit} out of range [0,${MAX_UNITS})`);
  return `${pad(step, STEP_WIDTH)}-${pad(unit, UNIT_WIDTH)}`;
};

// Inclusive id-range bounds for ALL units of a step → the lexicographic window the UI ranges
// over: documentId() in [stepLo, stepHi]. stepHi uses the max unit so it covers the whole step.
export const stepIdLo = (step) => unitDocId(step, 0);
export const stepIdHi = (step) => unitDocId(step, MAX_UNITS - 1);
