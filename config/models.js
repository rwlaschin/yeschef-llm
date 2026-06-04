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
//   topic         = <topic>                 e.g. llama3_2b_v1
//   subscription  = sub_<topic>             e.g. sub_llama3_2b_v1
//   dead-letter   = dead_letter_<topic>     e.g. dead_letter_llama3_2b_v1
//   image name    = ollama-<key>            e.g. ollama-slim
// ============================================================

export const MODELS = [
  { key: "slim",     label: "Llama 3.2 2B", model: "llama3.2:2b",                  topic: "llama3_2b_v1",    gpu: 1, dev: true  },
  { key: "large",    label: "Llama 3.3 70B", model: "llama3.3:70b-instruct-q4_K_M", topic: "llama3_3_70b_v1", gpu: 2, dev: false }, // 2× L4 — no dev GPU
  { key: "openclaw", label: "OpenClaw",      model: "openclaw",                     topic: "openclaw_v1",     gpu: 1, dev: true  },
];

export const subscriptionOf = (m) => `sub_${m.topic}`;
export const deadLetterOf   = (m) => `dead_letter_${m.topic}`;
export const imageOf        = (m) => `ollama-${m.key}`;
export const devModels      = () => MODELS.filter((m) => m.dev);
export const byTopic        = (topic) => MODELS.find((m) => m.topic === topic);
