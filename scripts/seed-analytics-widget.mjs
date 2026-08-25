// Seed the `analytics_widget` system prompt — "Ask Remy" for the /analytics ask box: ONE typed
// question → ONE chart spec. It is a /ai/query job (subtype "analytics_widget"), NOT a plan_library
// step: nothing fans out, one question asks for one chart. The worker concatenates
// systemPromptFor(type) + systemPromptFor(subtype) — see worker/lib/query.js — so this prompt IS the
// whole contract, and the answer is read by parseWidgetSpec()/validateWidget()
// (worker/analyticsWidget.js, mirrored in yeschef/src/lib/analytics/dashboards.ts).
//
// Idempotent (upsert by name). BACKS UP prompt_library to .backups/ first.
//
//   node scripts/seed-analytics-widget.mjs [--dry]
import { MongoClient } from "mongodb";
import dotenvFlow from "dotenv-flow";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WIDGET_METRICS, WIDGET_KINDS, WIDGET_REFUSAL } from "../worker/analyticsWidget.js";

dotenvFlow.config({ node_env: "dev" });
const DRY = process.argv.includes("--dry");
const dbName = process.env.MONGO_DB || "yeschef";

// NO EXAMPLE VALUES: a small model copies a worked example verbatim, and a filled-in specimen row
// here would come back as the answer to every question. The format is a field schema only.
export const ANALYTICS_WIDGET_PROMPT = {
  name: "Analytics Widget system",
  mapping: { analytics_widget: "a" },
  active: true,
  modelOverride: null,
  isDeleted: false,
  content: `You turn ONE question about a kitchen's numbers into ONE chart specification. You do not answer the question in words and you do not compute anything.

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

Every field must be filled. No extra keys, no comments, no prose, no heading, no explanation before or after the fence. Never guess a metric to avoid refusing: an unrelated chart is worse than "${WIDGET_REFUSAL}".`,
};

// Importable without touching Mongo — only a direct `node scripts/seed-analytics-widget.mjs` writes.
if (path.resolve(process.argv[1] ?? "") !== fileURLToPath(import.meta.url)) {
  // imported — expose the prompt only.
} else {
const uri = process.env.MONGO_URI;
if (!uri) { console.error("MONGO_URI not set (.env.dev)"); process.exit(1); }
const client = new MongoClient(uri);
try {
  await client.connect();
  const db = client.db(dbName);

  const promptLib = await db.collection("prompt_library").find({}).toArray();
  const dir = path.join(process.cwd(), ".backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = path.join(dir, `analytics-widget-seed-backup-${stamp}.json`);
  fs.writeFileSync(backup, JSON.stringify({ prompt_library: promptLib }, null, 2));
  console.log(`backed up prompt_library(${promptLib.length}) → ${backup}`);

  if (DRY) {
    console.log(`--dry: would upsert prompt_library "${ANALYTICS_WIDGET_PROMPT.name}" → mapping ${JSON.stringify(ANALYTICS_WIDGET_PROMPT.mapping)} (${ANALYTICS_WIDGET_PROMPT.content.length} chars)`);
    process.exit(0);
  }

  const r = await db.collection("prompt_library").updateOne(
    { name: ANALYTICS_WIDGET_PROMPT.name }, { $set: ANALYTICS_WIDGET_PROMPT }, { upsert: true });
  console.log(`prompt_library "${ANALYTICS_WIDGET_PROMPT.name}": ${r.upsertedCount ? "inserted" : "updated"}`);
} finally {
  await client.close();
}
}
