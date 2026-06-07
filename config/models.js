// ============================================================
// Single source of truth for LLM models, topics, and subscriptions.
//
// Imported by pubsub/setup.js, scripts/dev.js, scripts/deploy.js, and the
// dashboard. Pure data + helpers — no dependencies — so it's safe to import
// from node scripts AND Nuxt/Nitro server routes.
//
// Add or rename a model HERE only; everything else derives from it.
//
// Conventions (derived, never hand-written elsewhere):
//   topic         = <topic>                 e.g. llama3_2_3b_v1
//   subscription  = sub_<topic>             e.g. sub_llama3_2_3b_v1
//   dead-letter   = dead_letter_<topic>     e.g. dead_letter_llama3_2_3b_v1
//   image name    = ollama-<key>            e.g. ollama-slim
// ============================================================

export const MODELS = [
  // NOTE: Llama 3.2 only ships 1b/3b — there is no 2b tag (an "llama3.2:2b" pull
  // fails with "manifest: file does not exist"). Using 3b; switch to llama3.2:1b
  // for a lighter/faster dev model.
  { key: "slim",     label: "Llama 3.2 3B", model: "llama3.2:3b",                  topic: "llama3_2_3b_v1",  gpu: 1, dev: true  },
  { key: "large",    label: "Llama 3.3 70B", model: "llama3.3:70b-instruct-q4_K_M", topic: "llama3_3_70b_v1", gpu: 2, dev: false }, // 2× L4 — no dev GPU
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
  { key: "openclaw",        label: "OpenClaw (gemma3:4b)",     model: "gemma3:4b",                    topic: "openclaw_v1",              gpu: 1, dev: true,  gateway: "openclaw", tools: ["web_search", "web_fetch"] },
  { key: "openclaw-slim",   label: "OpenClaw (Llama 3.2 3B)",  model: "llama3.2:3b",                  topic: "openclaw_llama3_2_3b_v1",  gpu: 1, dev: true,  gateway: "openclaw", tools: ["web_search", "web_fetch"] },
  { key: "openclaw-large",  label: "OpenClaw (Llama 3.3 70B)", model: "llama3.3:70b-instruct-q4_K_M", topic: "openclaw_llama3_3_70b_v1", gpu: 2, dev: false, gateway: "openclaw", tools: ["web_search", "web_fetch"] },
];

export const subscriptionOf = (m) => `sub_${m.topic}`;
export const deadLetterOf   = (m) => `dead_letter_${m.topic}`;
export const imageOf        = (m) => `ollama-${m.key}`;
export const devModels      = () => MODELS.filter((m) => m.dev);
export const byTopic        = (topic) => MODELS.find((m) => m.topic === topic);

// Predetermined message/request types — the keys a prompt_library entry maps to.
// The dashboard's prompt editor offers these as a multi-select. Add a type here as
// the app starts sending it (the worker reads the live `type` off each message).
export const MESSAGE_TYPES = ["query", "recipe", "menu_plan", "nutrition", "inventory", "compliance", "procurement"];
