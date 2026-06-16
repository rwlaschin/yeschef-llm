// steps/compliance.js — owns: the "compliance" step builder.
// ============================================================
// Compliance is a STEP (subtype "compliance"), reached via the generic step path's subtype
// dispatch (steps/step.js → deps.subtypeBuilders.compliance), NOT as a top-level message type.
//
// What makes it different from a generic step:
//   • LIVE GROUNDING (web): compliance grounds against real, current rules via web_search/web_fetch.
//     Those tools are assigned per-step in the PLAN (authored in the dashboard, stored in the DB) and
//     carried through to the worker as payload.tools — NOT forced in code. The instruction to look
//     up authoritative sources, cite them, and FAIL/abstain when nothing authoritative is retrieved
//     lives in the `compliance` prompt (prompt_library). Compliance must never answer regulatory
//     specifics from the model's own memory.
//   • RAG (stubbed, optional): the Mongo `regulations` $vectorSearch path (deps.retrieveContext) is
//     kept wired for later but is OFF by default (RAG_ENABLED). When on it supplements the web
//     grounding; when off it returns "".
//
// Signature matches the subtype-builder contract used by steps/step.js (it passes the loaded
// plan `def`, not raw payload fields):
//   buildComplianceMessages({ payload, def, ctxBlocks, context, deps }) -> Promise<ChatMessage[]>
// ============================================================

import { buildMessages } from "./step.js";
import { section, joinSections } from "./prompt.js";

export async function buildComplianceMessages({ payload, def, ctxBlocks, context, deps }) {
  const system = await deps.systemPromptFor(def.subtype || "compliance");
  const instructions = def.instructions || payload.query || "";

  // Optionally supplement with Mongo `regulations` RAG on the instructions, unless the handler
  // already attached context. This is the STUBBED path (RAG_ENABLED off → returns ""); it's kept
  // for later and is non-fatal. It is NOT the safety net: live web grounding (forced tools) plus the
  // prompt's abstain rule are what keep compliance from inventing rules when no context is present.
  let rag = context;
  if (!rag && deps.retrieveContext && instructions) {
    try {
      rag = await deps.retrieveContext(instructions);
    } catch (e) {
      console.warn(`[worker]   compliance RAG unavailable (${e.message}) — proceeding without regulations context`);
    }
  }

  // "# Instructions" + the already-labeled prior-step results — same format as every builder.
  const user = joinSections(section("Instructions", instructions), ...ctxBlocks);
  return buildMessages(system, user, rag);
}
