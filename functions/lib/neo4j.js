// Neo4j read access for the /ai plan-build. The committed protein grid is the source of truth
// (yeschef writes it: Menu{id:planId} -[:HAS_SLOT]-> Slot{diet,day,mealtime} -[:BASE]-> Protein,
// with an optional per-site -[:SITE_BASE {siteId}]-> override). menu.js resolves the recipes step's
// protein seed FROM this at build time, so recipes mirror the grid — the client no longer sends it.
import neo4j from "neo4j-driver";

let _driver = null;
function driver() {
  if (_driver) return _driver;
  const { NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD } = process.env;
  if (!NEO4J_URI || !NEO4J_USERNAME || !NEO4J_PASSWORD) {
    throw new Error("Neo4j not configured (NEO4J_URI/USERNAME/PASSWORD)");
  }
  _driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USERNAME, NEO4J_PASSWORD));
  return _driver;
}

const normDiet = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();
const dayNum = (s) => { const m = /(\d+)/.exec(String(s || "")); return m ? parseInt(m[1], 10) : 0; };

// Per-slot protein seed for the recipes build, keyed the way {{proteinBackbone}} / cannedRecipes
// expect: normDiet(diet) -> dayNumber -> mealtime -> { type, cut? }. Site override (when siteId is
// given) wins over the master BASE, mirroring yeschef's menuProteins @cypher. Empty object when the
// plan has no committed grid yet — callers fall back to the (empty) client value / pool.
export async function resolveProteinSeed(planId, siteId = null) {
  if (!planId) return {};
  const session = driver().session();
  try {
    const res = await session.run(
      `MATCH (m:Menu {id: $planId})
       WHERE coalesce(m.isDeleted, false) = false
       MATCH (m)-[:HAS_SLOT]->(s:Slot)
       OPTIONAL MATCH (s)-[:BASE]->(bp:Protein)
       OPTIONAL MATCH (s)-[sb:SITE_BASE {siteId: $siteId}]->(sbp:Protein) WHERE $siteId IS NOT NULL
       WITH s,
            CASE WHEN sb IS NOT NULL THEN sbp ELSE bp END AS p
       WHERE p IS NOT NULL
       RETURN s.diet AS diet, s.day AS day, s.mealtime AS mealtime, p.type AS type, p.cut AS cut`,
      { planId, siteId: siteId ?? null },
    );
    const seed = {};
    for (const rec of res.records) {
      const type = rec.get("type");
      if (!type) continue;
      const nd = normDiet(rec.get("diet"));
      const d = dayNum(rec.get("day"));
      if (!d) continue;
      const cut = rec.get("cut");
      const byDay = seed[nd] ?? (seed[nd] = {});
      (byDay[d] ?? (byDay[d] = {}))[rec.get("mealtime")] = { type, ...(cut ? { cut } : {}) };
    }
    return seed;
  } finally {
    await session.close();
  }
}
