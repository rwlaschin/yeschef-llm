// steps/prompt.js — the SINGLE place that assembles labeled prompt sections.
//
// A prompt is built from several parts: the user's request, prior-step results, RAG context,
// and config the model needs (the assigned model topic, the tool list, the subtype list).
// Concatenated raw, they run straight into each other — you can't tell where the system/default
// text ends and the user's request begins (the exact bug this fixes: the system prompt's last
// line sat flush against "List the legal requirements…" with no boundary). So every part gets a markdown
// header, and the user's request ALWAYS sits under "# User Prompt" — unambiguous in the model's
// input AND in the dashboard's Prompt view.
//
// Shared by every builder (planner, generic step, compliance, and any future subtype/kind) so
// the format is identical everywhere. Add a new kind of section HERE, not inline in a builder,
// so one prompt never drifts from another.

// One labeled section → "# <Label>\n<body>". Blank/absent body → "" so joinSections drops it
// (no empty "# Tools" headers when there are no tools).
export function section(label, body) {
  const text = (body ?? "").toString().trim();
  return text ? `# ${label}\n${text}` : "";
}

// Join labeled sections — or already-labeled blocks like the per-step context — into one body,
// dropping empties, one blank line between each.
export function joinSections(...parts) {
  return parts.filter(Boolean).join("\n\n");
}

// The user's request — ALWAYS under its own header so it's never mistaken for default text.
// This is the join the user asked for: glue the user prompt onto any default/config sections
// with a clear, consistent label.
export const userPromptSection = (query) => section("User Prompt", query);
