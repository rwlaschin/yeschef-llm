// steps/step.js — owns: shared step assembly + context-window sizing.
// Used by every step builder (planner.js, compliance.js) and the generic step path.
// Pure where possible; the Firestore/Mongo-backed helpers are passed in via `deps` so this
// file stays unit-testable (see step.test.js). See design/worker-architecture.md.

import { section, joinSections } from "./prompt.js";
import { unitDocId } from "../../config/models.js";

// ---- Chat message assembly --------------------------------------------------
// Build chat messages from a system prompt (+ optional RAG context) and the user content.
// system text + the labeled "# Context" block become ONE system message; `query` is the user
// message (the builders pass it already assembled from labeled sections — see prompt.js). No
// system message if there's nothing to put in it.
export function buildMessages(system, query, context) {
  const messages = [];
  const sys = joinSections(system, section("Context", context));
  if (sys) messages.push({ role: "system", content: sys });
  messages.push({ role: "user", content: query });
  return messages;
}

// ---- Step loading -----------------------------------------------------------
// A step's DEFINITION lives in the job's `plan[]` metadata (frozen by the orchestrator). The
// tiny work message only carries {jobId, step}. Read plan[step] for subtype/instructions/
// contexts, then gather the results of the steps named in `contexts` (0-based indices). A prior
// step's output is the `response` of its active (non-deleted) run in steps/. deps.getFirestoreClient
// is injected. Returns { def, ctxBlocks } so builders decide how to assemble the prompt.
export async function loadStep(payload, deps) {
  const db = deps.getFirestoreClient();
  const jobDoc = db.collection("llmResults").doc(payload.jobId);
  const jobSnap = await jobDoc.get();
  const plan = (jobSnap.exists ? jobSnap.data().plan : null) || [];
  const def = plan[payload.step] || {};

  const ctxBlocks = [];
  for (const idx of def.contexts || []) {
    // A `chain` step rides its source step's fan-out 1:1 — THIS unit reads ONLY the source's matching
    // unit (small + aligned), not the whole step. Other kinds get the whole step joined (as before).
    if (def.kind === "chain" && typeof payload.unit === "number") {
      const d = await jobDoc.collection("steps").doc(unitDocId(idx, payload.unit)).get();
      const text = d.exists && !d.data().isDeleted ? (d.data().response || "") : "";
      if (text) ctxBlocks.push(`# Result of step ${idx} (unit ${payload.unit}):\n${text}`);
      continue;
    }
    const runs = await jobDoc.collection("steps").where("step", "==", idx).get();
    const text = runs.docs.filter((d) => !d.data().isDeleted).map((d) => d.data().response).filter(Boolean).join("\n\n");
    if (text) ctxBlocks.push(`# Result of step ${idx}:\n${text}`);
  }
  return { def, ctxBlocks };
}

// Generic step builder + subtype dispatch. A step routes by its `subtype` to a specialized
// builder (deps.subtypeBuilders[subtype], e.g. compliance) if one is registered; otherwise it
// uses the generic assembly: the subtype's system prompt + (instructions + prior-step contexts).
export async function buildStepMessages(payload, context, deps) {
  const { def, ctxBlocks } = await loadStep(payload, deps);

  // Fan-out individuation: a step that runs once-per-item carries a per-unit prompt array (def.units,
  // built by compose). Hand THIS unit (payload.unit) its own rendered instruction. Without this every
  // unit would get the same prompt (N identical clones) — this is what makes "once per institution /
  // per day" real. The orchestrator's `query` override below still wins (e.g. a retry directive).
  if (Array.isArray(def.units) && def.units[payload.unit] != null) def.instructions = def.units[payload.unit];

  // The orchestrator can hand us the directive in the message's `query` (the user-prompt field the
  // worker already reads on the standard/compliance/planner paths) instead of leaving us to read
  // plan[step] — e.g. a retry prompt it authored with the prior failure folded in. When present it
  // wins. We render whatever we're given and neither know nor care why it differs.
  if (payload.query != null) def.instructions = payload.query;

  // Runtime ids — substituted HERE (post-plan) because they only exist at execution: the job id, the
  // step's number, this fan unit's batch index, and the run-doc id. compose passes them through as
  // literal {{tokens}}; we fill the real values now (covers retry `query` prompts too).
  const runtimeIds = {
    jobId: payload.jobId ?? "",
    stepNumber: payload.step ?? "",
    batchIndex: payload.unit ?? 0,
    runId: unitDocId(payload.step, payload.unit ?? 0),
  };
  def.instructions = String(def.instructions ?? "").replace(
    /\{\{(jobId|stepNumber|batchIndex|runId)\}\}/g,
    (_, k) => String(runtimeIds[k])
  );

  const sub = deps.subtypeBuilders?.[def.subtype];
  if (sub) return sub({ payload, def, ctxBlocks, context, deps });

  const system = await deps.systemPromptFor(def.subtype || "query");
  // "# Instructions" + the already-labeled prior-step results. (Removed the "# Step type" note —
  // it injected the engine term "fan-out", which the model has no concept of, and was untested.)
  const user = joinSections(section("Instructions", def.instructions), ...ctxBlocks);
  return buildMessages(system, user, context);
}

// ---- Context-window sizing --------------------------------------------------
// Terminal (non-retriable) failure. The handler ACKs these instead of nacking, so they don't
// redeliver forever. Use when retrying cannot possibly succeed (e.g. context too large).
export class TerminalError extends Error {
  constructor(message) {
    super(message);
    this.name = "TerminalError";
    this.terminal = true;
  }
}

// Rough token estimate from characters. Conservative on purpose (smaller charsPerToken → MORE
// estimated tokens) so we OVER-allocate the window rather than truncate the prompt. Ollama has
// no tokenize endpoint, so an exact count isn't available before the call.
export function estimateTokens(text, charsPerToken = 3.5) {
  return Math.ceil((text?.length || 0) / charsPerToken);
}

// Decide the num_ctx to request for THIS call. num_ctx holds INPUT + OUTPUT, so size it to the
// prompt plus room for the answer (outputReserve), never below `floor`. If the need exceeds the
// model's max context, throw TerminalError — retrying can't shrink it, so fail fast & terminal.
export function sizeNumCtx({
  messages, modelMaxCtx, outputReserve = 4096, charsPerToken = 3.5,
  floor = 512, bufferPct = 0.15, minBuffer = 256, maxBuffer = 1024,
}) {
  const promptTokens = messages.reduce((n, m) => n + estimateTokens(m.content, charsPerToken), 0);
  const need = promptTokens + outputReserve;
  if (modelMaxCtx && need > modelMaxCtx) {
    throw new TerminalError(
      `context too large: ~${promptTokens} prompt + ${outputReserve} output reserve = ${need} tokens ` +
      `exceeds model cap ${modelMaxCtx}; reduce the request (chunk it, or trim the RAG/contexts).`
    );
  }
  // Headroom over the estimate: 15% of need, clamped to [minBuffer, maxBuffer] tokens.
  const buffer = Math.min(maxBuffer, Math.max(minBuffer, Math.ceil(need * bufferPct)));
  const want = Math.max(floor, need + buffer);
  return modelMaxCtx ? Math.min(want, modelMaxCtx) : want;
}
