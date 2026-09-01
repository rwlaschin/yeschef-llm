// worker/tools/subagent.js — a CLEAN-CONTEXT agent call. Mechanics only, no prompt.
//
// WHY THIS EXISTS: over ~20 measured runs a local model (llama3.1:8b, and the 70b tier) asked to
// review the table it had just written against its own stated Pass/Fail criteria never failed
// itself — it emitted a satisfied review paragraph even on runs whose rows plainly violated the
// criteria. The same model, given the same criteria and a single defective row in a FRESH call with
// no authorship of that row, flipped 3 of 4 defective rows to a correct verdict. The worker had no
// way to route work to a clean context; this is that way.
//
// WHAT THIS FILE IS NOT: it holds no task. The CALLING model supplies the ENTIRE prompt as the
// tool's `prompt` argument. Absent a prompt the call is refused rather than answered from something
// this file made up. NOTHING is added to the prompt — not a system message, not a label, not a
// configured preamble. The caller's string is the child's entire input, which is what makes this a
// general tool: any wording the child needs is wording the caller already owns and can change.
// Mechanically it is one more round on the SAME host, model, num_ctx and sampler.

import { chatRound } from "../ollama.js";

export const SUB_AGENT_TOOL_NAME = "sub_agent";

// One run's sub-agent state. Constructed by handleMessage — where `numCtx` and the run doc both
// already exist — and NOT defaulted inside chatWithTools: a state object created downstream of the
// run doc's write can never be persisted, so its tracking would reach nothing.
export class SubAgent {
  constructor({ numCtx, sampler, depth = 0, toolDefs, chat } = {}) {
    this.numCtx = numCtx;   // the parent's window — reused so Ollama keeps the loaded runner
    this.sampler = sampler; // the parent's resolved sampler
    this.depth = depth;     // 0 = a parent run. > 0 refuses, see the depth guard
    this.toolDefs = toolDefs; // the child's tools slot: the step's tools MINUS sub_agent itself
    this.chat = chat;       // the transport. handleMessage passes a tool-executing loop when toolDefs
                            // is non-empty — chatRound alone would leave the child's tool_calls unrun
    this.calls = [];        // every call, in order
  }

  snapshot() { return { calls: this.calls }; }
}

// The child call, plus the tracking record. `chat` is injectable (matching worker/ollama.js's
// injectable-opts convention) so the unit tests never reach Ollama.
export async function runSubAgent(sub, { trigger = "model", args = null, chat } = {}) {
  // The depth guard is now the mechanism, not a backstop: the child HAS a tools slot, so recursion
  // is prevented by refusing at depth > 0 and by handleMessage removing sub_agent from the child's
  // own tool list. Either alone would do; both is deliberate.
  if (sub.depth > 0) return { error: "sub_agent is not available inside a sub_agent call." };
  // The CALLING model supplies the whole prompt. Nothing here substitutes for an absent one — a
  // default would be this file inventing the task, which is the one thing it must never do.
  const prompt = String(args?.prompt ?? "").trim();
  if (!prompt) return { error: "sub_agent needs a `prompt`: the complete prompt for the fresh agent." };

  // Recorded BEFORE the call is issued and completed in place, so a call that throws still appears —
  // a silent tool is indistinguishable from one never called.
  const record = {
    n: sub.calls.length + 1,
    trigger,
    at: new Date().toISOString(),
    ms: 0,
    sent: { prompt },          // exactly what reached the child, verbatim
    got: null,
    error: null,
  };
  sub.calls.push(record);

  const started = Date.now();
  try {
    const { content } = await (chat ?? sub.chat ?? chatRound)(
      // One message: exactly the caller's prompt, verbatim. Nothing of ours is added to it.
      [{ role: "user", content: prompt }],
      sub.toolDefs,     // the tools slot. undefined = none, which is what a bare SubAgent gets.
      () => {},         // onChunk: a sink. chatRound awaits it per piece; the child's text must never
                        // reach the parent's Firestore response stream or the live UI.
      sub.numCtx,       // the PARENT's num_ctx, UNCHANGED. A different num_ctx makes Ollama reload the
                        // runner — tens of seconds. Same host, same model, same window, same weights.
      { sampler: sub.sampler },  // the parent's resolved sampler. No host, model or agent override, so
                        // chatRound's env defaults and its module-level keep-alive agent are reused:
                        // an already-open socket, ~2-3ms to first byte, no process, no model load.
    );
    // TEXT, and only text. Parsing the step framework's status marker here would decide, for every
    // caller, that the child's answer is a verdict — a caller asking for a second draft would get
    // status/reason welded onto its result. A caller that wants a status block parses its own.
    record.ms = Date.now() - started;
    record.got = { response: content };
    return { response: content };
  } catch (err) {
    record.ms = Date.now() - started;
    record.error = err?.message || String(err);
    return { error: record.error };
  }
}
