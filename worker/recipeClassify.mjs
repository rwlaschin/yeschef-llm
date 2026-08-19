// "Does this step change or hold food temperature?" as a CLASSIFICATION, not a generation.
//
// A verb list was gamed the moment text was reworded ("Cool 30 minutes" -> "Rest 30 minutes"). An
// instruct model answers it correctly but is a 8B generation per step. The question is really
// nearest-neighbour: is this sentence more like "braise until 165F" or more like "scatter the
// topping"? That is what an embedding model is for — nomic-embed-text is 137M, deterministic at
// temperature 0, and already installed.
//
// Exemplars are the spec. Adding a missed case = adding a sentence, not editing a regex.
const HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text";

// Deliberately worded WITHOUT the giveaway verbs where possible, so the classifier learns the
// operation rather than the vocabulary — that is the whole failure being fixed.
const CHANGES_TEMP = [
  "Braise covered until the meat is fork tender.",
  "Rest the hot roast 30 minutes before slicing.",
  "Bring the soup back up before service.",
  "Let the pan come down to room temperature before cutting.",
  "Keep the pan on the steam table for service.",
  "Bring the product down from 135F to 41F in shallow pans.",
  "Reheat the pan in the combi before panning.",
  "Leave the tray in the refrigerator until service.",
  "Roast the pans in the convection oven until done.",
  "Hold the soup in the well through the meal period.",
];
const NO_TEMP_CHANGE = [
  "Scatter the topping evenly over each pan without pressing it down.",
  "Cut cold butter into the flour until it forms pea-sized crumbs.",
  "Portion with a No. 8 scoop into serving bowls.",
  "Whisk the oil, lemon juice and herbs together.",
  "Wash the produce in three changes of cold water.",
  "Arrange the fillets in a single layer in oiled pans.",
  "Slice the cucumbers a quarter inch thick.",
  "Garnish each glass with one lemon wedge.",
  "Combine the dry ingredients in a mixer bowl.",
  "Label and date the container.",
];

async function embed(input) {
  const res = await fetch(`${HOST}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input }),
  });
  if (!res.ok) throw new Error(`ollama embed ${res.status}`);
  return (await res.json()).embeddings;
}

const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};
const centroid = (vs) => vs[0].map((_, i) => vs.reduce((s, v) => s + v[i], 0) / vs.length);

let poles = null;
async function loadPoles() {
  if (poles) return poles;
  const vecs = await embed([...CHANGES_TEMP, ...NO_TEMP_CHANGE]);
  poles = { hot: centroid(vecs.slice(0, CHANGES_TEMP.length)), cold: centroid(vecs.slice(CHANGES_TEMP.length)) };
  return poles;
}

// Returns { changesTemp, margin } — margin is how far from the decision boundary, so a caller can
// treat a near-tie as "ask a bigger model" instead of guessing.
export async function classifySteps(texts) {
  const { hot, cold } = await loadPoles();
  const vecs = await embed(texts);
  return vecs.map((v) => {
    const dHot = cosine(v, hot), dCold = cosine(v, cold);
    return { changesTemp: dHot > dCold, margin: Math.abs(dHot - dCold) };
  });
}

// TWO-STAGE GATE. The embedding pass is free and decides the clear cases; only steps NEAR THE
// BOUNDARY go to an instruct model. Correctness matters more than speed here (this runs in
// integration/e2e, not in the request path), but calling an 8B for all 114 steps to resolve the
// handful that are actually ambiguous is waste, not rigour.
const AMBIGUOUS_MARGIN = 0.10;

export async function stepChangesTemp(texts, { model = "llama3.1:8b" } = {}) {
  const cheap = await classifySteps(texts);
  const out = cheap.map((v) => ({ ...v, source: "embed" }));
  const unsure = cheap.map((v, i) => (v.margin < AMBIGUOUS_MARGIN ? i : -1)).filter((i) => i >= 0);
  if (!unsure.length) return out;
  const { lintStepText } = await import("./recipeLint.mjs");
  for (const i of unsure) {
    const verdict = await lintStepText(texts[i], model);
    if (verdict !== null) out[i] = { changesTemp: verdict, margin: cheap[i].margin, source: model };
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { DISH_FIXTURES } = await import("./dishFixtures.js");
  const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
  const dishes = only ? DISH_FIXTURES.filter((d) => d.name.includes(only)) : DISH_FIXTURES;
  const t0 = Date.now();
  let flagged = 0, steps = 0;
  for (const d of dishes) {
    const verdicts = process.argv.includes('--escalate')
      ? await stepChangesTemp(d.method.map((s) => s.text))
      : await classifySteps(d.method.map((s) => s.text));
    d.method.forEach((s, i) => {
      steps++;
      const v = verdicts[i];
      if (v.changesTemp && typeof s.criticalTempF !== "number") {
        flagged++;
        console.log(`MISSING TEMP  ${d.name} · step ${s.order} (margin ${v.margin.toFixed(3)}, ${v.source ?? "embed"})\n              "${s.text.slice(0, 95)}"`);
      }
    });
  }
  console.log(`\n${dishes.length} dishes · ${steps} steps · ${flagged} missing a temperature · ${EMBED_MODEL} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
