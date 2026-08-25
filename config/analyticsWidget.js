// The `analytics_widget` output contract: ONE chart spec for ONE typed question, or a refusal.
//
// The answer is either the exact line `CANNOT ANSWER` (the question is not about any metric we
// hold) or a yaml fence with exactly three keys:
//
//   ```yaml
//   title: Take rate by site
//   metric: takeRate
//   kind: line
//   ```
//
// The yeschef app parses the same three lines (src/lib/analytics/dashboards.ts, parseWidgetSpec)
// and refuses to draw anything the validator below rejects — there is NO default chart, so a
// malformed answer must surface as a failure, never as an unrelated chart.
//
// Lives in config/ (not worker/) because BOTH sides need it: the worker's canned tier and the
// /ai/tquery route's output gate. functions/config is a symlink to this directory, so a function
// can import it without escaping its deploy bundle; worker/analyticsWidget.js re-exports it so
// every existing importer is unchanged.

export const WIDGET_METRICS = ["takeRate", "mealsServed", "ingredientsLbs", "dietBreakdown"];
export const WIDGET_KINDS = ["bar", "line", "donut", "stack"];
export const WIDGET_REFUSAL = "CANNOT ANSWER";

/** Read the three fields out of a model answer. Returns null for a refusal or no fields at all. */
export function parseWidgetSpec(text) {
  const body = String(text ?? "");
  if (new RegExp(`^\\s*${WIDGET_REFUSAL}\\s*$`, "im").test(body)) return null;
  const field = (k) => {
    const m = body.match(new RegExp(`^[^\\S\\n]*${k}[^\\S\\n]*:[^\\S\\n]*(\\S.*?)[^\\S\\n]*$`, "im"));
    return m ? m[1].replace(/^["']|["']$/g, "") : undefined;
  };
  const spec = { title: field("title"), metric: field("metric"), kind: field("kind") };
  return spec.title || spec.metric || spec.kind ? spec : null;
}

/**
 * Defects in a parsed widget spec — [] means usable. One string per defect, validateDish style:
 * a non-empty array is a failure, there is no "mostly valid".
 */
export function validateWidget(spec) {
  if (!spec || typeof spec !== "object") return ["no chart specification in the answer"];
  const e = [];
  if (!spec.title || typeof spec.title !== "string") e.push("missing title");
  if (!WIDGET_METRICS.includes(spec.metric)) e.push(`metric "${spec.metric}" is not one of the available metrics`);
  if (!WIDGET_KINDS.includes(spec.kind)) e.push(`kind "${spec.kind}" is not a chart form`);
  return e;
}

// The step's INSTRUCTIONS text. Nothing in prompt_library maps `analytics_widget`, so the contract
// rides on the step's instructions (worker/steps/step.js renders it as the "# Instructions" section)
// — the same arrangement /ai/categorize documents for subtype "task".
//
// NO EXAMPLE VALUES: a small model copies a worked example verbatim, and a filled-in specimen row
// here would come back as the answer to every question. The format is a field schema only.
export const widgetInstructions = (question) => `You turn ONE question about a kitchen's numbers into ONE chart specification. You do not answer the question in words and you do not compute anything.

You may ONLY use these metrics, spelled exactly as listed:
- takeRate — the share of served meals residents actually take, weekly, per site.
- mealsServed — how many meals were served, monthly, split by breakfast / lunch / dinner.
- ingredientsLbs — pounds of each ingredient used.
- dietBreakdown — how many residents are on each therapeutic diet.

Chart forms, spelled exactly as listed: ${WIDGET_KINDS.join(", ")}. Pick the one the metric reads best in: a trend over time is a line, a comparison across named things is a bar, parts of one whole is a donut, and several series stacked over time is a stack.

If the question cannot be answered by one of those four metrics — it asks about anything else, names data we do not hold, or asks for a number rather than a chart — answer with EXACTLY this one line and nothing else:
${WIDGET_REFUSAL}

Otherwise output NOTHING but this fenced block, three lines, in this order:
\`\`\`yaml
title: <a short chart title, at most 60 characters, in the words the asker used>
metric: <one of: ${WIDGET_METRICS.join(", ")}>
kind: <one of: ${WIDGET_KINDS.join(", ")}>
\`\`\`

Every field must be filled. No extra keys, no comments, no prose, no heading, no explanation before or after the fence. Never guess a metric to avoid refusing: an unrelated chart is worse than "${WIDGET_REFUSAL}".

The question:
${question}`;
