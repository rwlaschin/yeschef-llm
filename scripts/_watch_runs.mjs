// READ-ONLY one-shot: print a job's step runs (status, response length, outcome) from prod Firestore.
// No writes. Usage: node scripts/_watch_runs.mjs <jobId> [stepPrefix]
import "dotenv-flow/config";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const jobId = process.argv[2];
const prefix = process.argv[3] || ""; // e.g. "002-" to filter step 2 units
initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || process.env.GCP_PROJECT_ID });
const db = getFirestore();

const snap = await db.collection("llmResults").doc(jobId).collection("steps").get();
const rows = snap.docs
  .map((d) => ({ id: d.id, ...d.data() }))
  .filter((r) => r.id.startsWith(prefix))
  .sort((a, b) => (a.id < b.id ? -1 : 1));

const now = Date.now();
const ms = (t) => (t?.toMillis ? t.toMillis() : null);
const ago = (t) => { const m = ms(t); return m ? `${Math.round((now - m) / 1000)}s` : "—"; };
let done = 0, running = 0, fail = 0;
for (const r of rows) {
  if (r.status === "success") done++;
  else if (r.status === "fail") fail++;
  else if (r.status === "running") running++;
  const len = (r.response || "").length;
  const tail = r.status === "fail" && r.outcome ? `  ✗ ${String(r.outcome).slice(0, 60)}` : "";
  console.log(
    `${r.id}  ${String(r.status || "-").padEnd(8)}  resp=${String(len).padStart(6)}ch  ` +
    `upd=${ago(r.updatedAt).padStart(5)} ago  done=${ago(r.completedAt).padStart(5)}  att=${r.attempt ?? "-"}${tail}`
  );
}
console.log(`\n${rows.length} runs — ${done} success, ${fail} fail, ${running} running`);
process.exit(0);
