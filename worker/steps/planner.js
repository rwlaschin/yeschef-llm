// steps/planner.js — owns: the planner step builder.
// Turns a user request into the inputs for a YAML step plan: the planner system prompt, plus a
// user block listing the assigned model topic, the available tools, the subtypes, and the prompt.
// Mongo-backed helpers (systemPromptFor/getTools/getSubtypes) are injected via `deps`.
// NOTE: the planner must run TOOL-FREE — see the handler's tool policy. It ASSIGNS tools to
// steps in its output; it does not call them.

import { buildMessages } from "./step.js";
import { section, joinSections, userPromptSection } from "./prompt.js";

export async function buildPlannerMessages(payload, context, deps) {
  const system = await deps.systemPromptFor("planner");                              // ①
  if (!system) console.warn(`[worker]   planner prompt EMPTY — nothing maps to "planner" in prompt_library`);
  const [tools, subtypes] = await Promise.all([deps.getTools(), deps.getSubtypes()]); // ②③ (pre-joined strings)
  // Each part is its own labeled section (prompt.js), so the planner's config and the user's
  // actual request are clearly delineated — the request always lands under "# User Prompt"
  // instead of running flush against the system prompt's last line.
  const user = joinSections(
    section("Model", `${payload.model}    # assign each step to THIS model topic — do not choose another`),
    section("Tools", tools),
    section("Subtypes", subtypes),
    userPromptSection(payload.query),                                                // ④
  );
  return buildMessages(system, user, context);
}
