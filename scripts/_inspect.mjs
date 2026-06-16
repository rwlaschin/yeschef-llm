// Throwaway dev inspector for llmResults. Usage (NODE_ENV=dev):
//   node scripts/_inspect.mjs list
//   node scripts/_inspect.mjs job <jobId>
//   node scripts/_inspect.mjs steps <jobId>
import admin from "firebase-admin";
import dotenvFlow from "dotenv-flow";
dotenvFlow.config();

const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCP_PROJECT_ID || "yeschef-c572a";
admin.initializeApp({ projectId });
const db = admin.firestore();
const COLL = "llmResults";

const ms = (t) => (t?.toMillis ? t.toMillis() : null);
const short = (s, n = 80) => (typeof s === "string" ? (s.length > n ? s.slice(0, n) + `…(${s.length})` : s) : s);

const [, , cmd, arg] = process.argv;

async function list() {
  const snap = await db.collection(COLL).orderBy("createdAt", "desc").limit(10).get();
  for (const d of snap.docs) {
    const x = d.data();
    console.log(`${d.id}  status=${x.status}  type=${x.type ?? "?"}  steps=${x.stepCount ?? "?"}  cursor=${x.cursor ?? "?"}  msg=${short(x.message, 50)}`);
  }
}

async function job(id) {
  const d = await db.collection(COLL).doc(id).get();
  if (!d.exists) return console.log("NO SUCH JOB", id);
  const x = d.data();
  console.log(JSON.stringify({
    id, status: x.status, type: x.type, cursor: x.cursor, stepCount: x.stepCount,
    outcome: x.outcome, message: short(x.message, 120),
    plan: Array.isArray(x.plan) ? x.plan.map((p, i) => ({ i, subtype: p.subtype, kind: p.kind, includeInResults: p.includeInResults, instruction: short(p.instruction ?? p.prompt ?? p.task, 90) })) : x.plan,
  }, null, 2));
}

async function steps(id) {
  const snap = await db.collection(COLL).doc(id).collection("steps").get();
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const r of rows) {
    const created = ms(r.createdAt), updated = ms(r.updatedAt);
    const rt = created && updated ? `${((updated - created) / 1000).toFixed(1)}s` : "—";
    console.log(`${r.id}  step=${r.step}  status=${r.status}  del=${r.isDeleted ? "Y" : "n"}  rt=${rt}  outcome=${short(r.outcome, 60)}  resp=${short(r.response, 70)}`);
  }
  if (!rows.length) console.log("(no step runs)");
}

const fn = { list, job: () => job(arg), steps: () => steps(arg) }[cmd];
if (!fn) { console.log("cmd: list | job <id> | steps <id>"); process.exit(1); }
await fn();
process.exit(0);
