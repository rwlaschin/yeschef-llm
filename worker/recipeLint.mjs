// SEMANTIC lint for standardized recipes — the half a regex cannot do.
//
// recipeTemplate.js checks what is objectively checkable: a quantity is a number, steps are ordered,
// a yield exists. It also tried to answer "does this step cook, cool or hold food?" with a verb
// list, and that failed the moment text was reworded around it — "Cool 30 minutes" became "Rest 30
// minutes" and the missing temperature passed. The question is about MEANING, so it goes to a model.
//
// Runs against a local Ollama (llama3.2:1b is enough — this is classification, not generation). It
// is a LINT SCRIPT, deliberately not a unit test: a suite that needs a daemon running is not a
// suite, and a non-deterministic assert is worse than no assert.
//
//   node worker/recipeLint.mjs            # lint the fixtures
//   node worker/recipeLint.mjs --model llama3.1:8b
const HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const MODEL = process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1] : "llama3.2:1b";

// One narrow question per call. A small model answers a yes/no about a single sentence reliably;
// asked to "review this recipe" it free-associates.
const ASK = `You are a food-safety auditor reading ONE step of an institutional recipe.
Answer ONLY with JSON: {"changesTemp": true|false, "why": "<8 words max>"}
changesTemp is true if the step COOKS, REHEATS, COOLS, CHILLS, FREEZES, or HOLDS food at a
temperature — including resting hot food, cooling before cutting, or holding for service.
changesTemp is false for steps that only mix, cut, portion, plate, garnish, wash, or assemble.
STEP: `;

async function askOllama(prompt) {
  const res = await fetch(`${HOST}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt, stream: false, format: "json", options: { temperature: 0 } }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const { response } = await res.json();
  try { return JSON.parse(response); } catch { return { changesTemp: null, why: "unparseable" }; }
}

// One step, one yes/no — used by the escalation path in recipeClassify.mjs for near-ties only.
export async function lintStepText(text, model = MODEL) {
  const res = await fetch(`${HOST}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: ASK + JSON.stringify(text), stream: false, format: "json", options: { temperature: 0 } }),
  });
  if (!res.ok) return null;
  try { return JSON.parse((await res.json()).response).changesTemp === true; } catch { return null; }
}

// A step the model says changes temperature MUST carry a criticalTempF, whatever words it used.
export async function lintDish(dish) {
  const findings = [];
  for (const s of dish.method ?? []) {
    const verdict = await askOllama(ASK + JSON.stringify(s.text));
    if (verdict.changesTemp === true && typeof s.criticalTempF !== "number") {
      findings.push({ dish: dish.name, order: s.order, text: s.text, why: verdict.why });
    }
  }
  return findings;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { DISH_FIXTURES } = await import("./dishFixtures.js");
  const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
  const dishes = only ? DISH_FIXTURES.filter((d) => d.name.includes(only)) : DISH_FIXTURES;
  let total = 0;
  for (const d of dishes) {
    const f = await lintDish(d);
    total += f.length;
    for (const x of f) console.log(`MISSING TEMP  ${x.dish} · step ${x.order}\n              "${x.text.slice(0, 100)}"\n              model: ${x.why}`);
  }
  console.log(`\n${dishes.length} dishes linted with ${MODEL} — ${total} step(s) change temperature with no criticalTempF`);
  process.exit(total ? 1 : 0);
}
