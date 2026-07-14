export async function buildStandardMessages(payload, context, { systemPromptFor, buildMessages }) {
  let system = await systemPromptFor(payload.type || "query");
  if (payload.subtype) {
    const subtypeSystem = await systemPromptFor(payload.subtype);
    if (subtypeSystem) system = system ? `${system}\n\n${subtypeSystem}` : subtypeSystem;
  }
  return buildMessages(system, payload.query, context);
}

// The UI depends on the worker to convert recipe YAML → JSON — it never parses YAML itself.
// Same YAML→JSON transform as everywhere else (parseYamlBlock), applied to the `recipe` subtype.
// This MUST run on every path, including fake/canned responses, or the UI receives unparseable
// YAML and renders nothing. On empty/malformed YAML we keep the raw text rather than failing the
// job, so a bad model output surfaces instead of silently swallowing it.
export function formatRecipeYaml(runStatus, payload, cleanResponse, parseYamlBlock, originalOutcome = null) {
  let finalResponse = cleanResponse;
  const outcome = originalOutcome;

  if (runStatus === "success" && payload.subtype === "recipe") {
    try {
      const parsed = parseYamlBlock(cleanResponse);
      if (parsed) finalResponse = JSON.stringify(parsed);
    } catch (e) {
      console.warn(`[worker]   ${payload.jobId || "unknown"} failed to parse recipe YAML to JSON: ${e.message}`);
    }
  }

  return { runStatus, finalResponse, outcome };
}
