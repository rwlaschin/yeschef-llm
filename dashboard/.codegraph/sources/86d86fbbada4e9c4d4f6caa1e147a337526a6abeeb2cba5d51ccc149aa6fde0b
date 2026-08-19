// Find a past `protein_dietary_categorization` job that already answers the form's current question,
// so the form can BIND it instead of publishing an identical one.
//
// WHY: MenuForm keys its auto-fetch on `${diets}|${location}` and guards with a plain `let
// lastProteinsKey` — which is per component instance, so it is null again on every mount. A page
// load, a hot reload or a diet round-trip therefore each published a fresh job asking a question
// already answered. They pile up in the history, and (the emulator runs ONE function instance)
// they queue in front of real work — a 152s menu build behind two of these is what timed out a
// step re-run at 15s.
//
// The step is deterministic in its inputs: same diets, same location, same chef-typed proteins ⇒
// same question. Nothing else on the form reaches this prompt, which is exactly why the form keys
// on those two.
import { collection, getDocs, limit, orderBy, query } from 'firebase/firestore'
import { getDb } from '~/lib/firebase'

// The signature a job's OWN frozen plan resolves to — matched against the form's key rather than a
// label, which is display text. renderCtx is what the prompt was rendered from: `tz` holds the raw
// IANA location the form sent (functions/entry/ai/menu.js:181 derives region FROM it), `diets` the
// diet set. A job with any other shape is not this step and cannot answer for it.
const proteinsKeyOfJob = (job: any): string | null => {
  const step = job?.plan?.[0]
  if (!Array.isArray(job?.plan) || job.plan.length !== 1) return null
  if (step?.subtype !== 'protein_dietary_categorization') return null
  const diets: string[] = Array.isArray(step.renderCtx?.diets) ? step.renderCtx.diets : []
  if (!diets.length) return null
  return `${[...diets].sort().join(',')}|${step.renderCtx?.tz || ''}`
}

const norm = (xs: string[]) => [...xs].map((p) => String(p).toLowerCase()).sort().join(',')

// Newest reusable jobId, or null. The caller binds it and the ordinary parse path hydrates from its
// steps — nothing downstream can tell a cache hit from a fresh build.
//
// Client-side filter over one ordered field, no `where` (mirrors pages/menu.vue's history panel) —
// so no composite index. `addedProteins` is part of the identity: a chef-typed protein changes the
// question, so a job that predates it must not be reused.
export async function findCachedProteinsJob(
  proteinsKey: string,
  addedProteins: string[] = [],
  opts: { fake?: boolean; scan?: number } = {},
  companyId = '',
): Promise<string | null> {
  if (!companyId) return null   // never reuse across an unknown owner — build instead
  const coll = useRuntimeConfig().public.firestoreCollectionResults || 'llmResults'
  const snap = await getDocs(query(collection(getDb(), coll), orderBy('createdAt', 'desc'), limit(opts.scan ?? 50)))
  const wantAdded = norm(addedProteins)
  for (const d of snap.docs) {
    const job: any = d.data()
    if (job.status !== 'success' || job.isDeleted === true) continue
    // COMPANY IS A HARD BOUNDARY. diets+location alone are not unique to a kitchen — two companies
    // on the same diets in the same region would otherwise hand each other their protein lists.
    if (job.companyId !== companyId) continue
    // A fake-data job answers a different question than a real one; neither may satisfy the other.
    if (Boolean(job.fake) !== Boolean(opts.fake)) continue
    if (proteinsKeyOfJob(job) !== proteinsKey) continue
    if (norm(Array.isArray(job.plan[0].renderCtx?.addedProteins) ? job.plan[0].renderCtx.addedProteins : []) !== wantAdded) continue
    return job.jobId || d.id
  }
  return null
}
