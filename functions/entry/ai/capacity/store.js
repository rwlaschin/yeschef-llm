// Durable Mongo state for the capacity-steering controller (docs/plans/capacity-steering/plan.md).
// Two collections, both bounded and self-pruning — writes are in-place upsert `$inc`/`$set`, NEVER
// a per-event append:
//   region_capacity_stats — one doc per (region, daypart, day). daypart = `${dow}-${hh}` (mon..sun ×
//     00..23), day = YYYY-MM-DD (both UTC, so a box's local tz can never split one hour across docs).
//     A 30-day TTL on `dayTs` (a real Date at that day's UTC midnight) prunes the sliding window, so
//     the collection is bounded to regions × dayparts × 30.
//   region_capacity_state — one doc per region: current mode + consecutive-stockout streak + last-event
//     timestamps and the Phase-1 recorded decision (wouldOpen/wouldPark).
//
// Reuses functions/lib/mongo.js — the ONE shared, warm-cached client — never a new MongoClient here.
import { getCollection } from "../../../lib/mongo.js";

const STATS_COLL = "region_capacity_stats";
const STATE_COLL = "region_capacity_state";

const WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// The daypart key `${dow}-${hh}` (sun..sat × 00..23) in UTC — the DB stores everything in UTC; the
// dashboard converts to local for display. Exported so the controller keys the scoring window off
// the EXACT same computation the stats writes use — the two must never drift.
export function daypartOf(whenMs) {
  const d = new Date(whenMs);
  return `${DOW[d.getUTCDay()]}-${String(d.getUTCHours()).padStart(2, "0")}`;
}

// (region, daypart, day) key + the Date the TTL prunes on, all derived from one timestamp in UTC.
function keyOf(whenMs) {
  const d = new Date(whenMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return { daypart: daypartOf(whenMs), day: `${yyyy}-${mm}-${dd}`, dayTs: new Date(Date.UTC(yyyy, d.getUTCMonth(), d.getUTCDate())) };
}

// Ensure indexes once per warm process. Unique compound key guarantees the single doc that $inc
// upserts into; the TTL index expires a stats doc WINDOW_DAYS after its day's UTC midnight.
async function ensureIndexes() {
  if (globalThis.__yclCapacityIdx) return;
  const stats = await getCollection(STATS_COLL);
  await Promise.all([
    stats.createIndex({ region: 1, daypart: 1, day: 1 }, { unique: true }),
    stats.createIndex({ dayTs: 1 }, { expireAfterSeconds: WINDOW_DAYS * DAY_MS / 1000 }),
    stats.createIndex({ region: 1, daypart: 1, dayTs: 1 }),
  ]);
  const state = await getCollection(STATE_COLL);
  await state.createIndex({ region: 1 }, { unique: true });
  globalThis.__yclCapacityIdx = true;
}

// In-place upsert $inc of ok/fail on the current (region, daypart, day) doc — never an append.
async function inc(region, whenMs, field) {
  await ensureIndexes();
  const { daypart, day, dayTs } = keyOf(whenMs);
  const stats = await getCollection(STATS_COLL);
  await stats.updateOne(
    { region, daypart, day },
    { $inc: { [field]: 1 }, $setOnInsert: { region, daypart, day, dayTs } },
    { upsert: true },
  );
}

export const incOk = (region, whenMs) => inc(region, whenMs, "ok");
export const incFail = (region, whenMs) => inc(region, whenMs, "fail");

// The in-window daily rows for one region+daypart: every doc whose dayTs is within the last
// WINDOW_DAYS of nowMs. Returns `[{ ok, fail }]` for the scorer to sum; empty when none.
export async function windowRows(region, daypart, nowMs) {
  await ensureIndexes();
  const stats = await getCollection(STATS_COLL);
  const cutoff = new Date(nowMs - WINDOW_DAYS * DAY_MS);
  const docs = await stats
    .find({ region, daypart, dayTs: { $gte: cutoff } }, { projection: { _id: 0, ok: 1, fail: 1 } })
    .toArray();
  return docs.map((d) => ({ ok: d.ok || 0, fail: d.fail || 0 }));
}

// ── region_capacity_state ──────────────────────────────────────────────────────────────────────
// All per-region state docs (getState takes no arg — the controller reads the whole set to select).
export async function getState() {
  const state = await getCollection(STATE_COLL);
  return state.find({}, { projection: { _id: 0 } }).toArray();
}

// In-place $set upsert of a patch onto one region's state doc.
export async function setState(region, patch) {
  await ensureIndexes();
  const state = await getCollection(STATE_COLL);
  await state.updateOne(
    { region },
    { $set: { ...patch, region } },
    { upsert: true },
  );
}

// Consecutive-stockout streak on the region's state doc. A stockout $inc's it; ANY success resets it to
// 0 (folded into onOutcome's lastSuccessTs setState). select() parks a region once the streak reaches
// maxStockouts — recovery is via exploration, not a timer (see score.js). lastStockoutTs is stamped in
// the SAME upsert so a first-ever stockout creates the doc with both fields.
// Returns the POST-increment streak, read atomically from the same write. Callers must NOT re-read it
// with a separate getState(): the MIG retries a failed create about every 10s, so concurrent stockouts
// each read the same value and every one of them re-runs the abandon+cascade.
export async function bumpStockoutStreak(region, whenMs) {
  await ensureIndexes();
  const state = await getCollection(STATE_COLL);
  const r = await state.findOneAndUpdate(
    { region },
    { $inc: { consecutiveStockouts: 1 }, $set: { region, lastStockoutTs: whenMs } },
    { upsert: true, returnDocument: "after" },
  );
  // Driver v5 returns the doc directly; v4 wraps it in { value }.
  return (r?.value ?? r)?.consecutiveStockouts ?? 0;
}

// ── region_capacity_queue ────────────────────────────────────────────────────────────────────────
// Message-detected events, keyed by topic (model-agnostic — a new model is just a new _id, no code
// change). Set pending on enqueue-detect; clear on drain. Feeds the observe loop (and Phase-2 steering).
const QUEUE_COLL = "region_capacity_queue";
export async function recordMessageDetected(topic, whenMs) {
  const c = await getCollection(QUEUE_COLL);
  await c.updateOne(
    { _id: topic },
    { $set: { topic, lastDetectedTs: whenMs, pending: true }, $inc: { detected: 1 } },
    { upsert: true },
  );
}
export async function recordQueueDrained(topic, whenMs) {
  const c = await getCollection(QUEUE_COLL);
  await c.updateOne({ _id: topic }, { $set: { topic, lastDrainedTs: whenMs, pending: false } }, { upsert: true });
}

// Durable idempotency for detect-message: returns TRUE only the first time a Pub/Sub messageId is
// seen, so redeliveries AND a detector restart (unacked replay) never double-count. TTL keeps the
// dedup set bounded (7d > any redelivery window).
const SEEN_COLL = "region_capacity_seen";
let _seenTtl = false;
export async function markMessageSeen(messageId, whenMs) {
  const c = await getCollection(SEEN_COLL);
  if (!_seenTtl) { await c.createIndex({ ts: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 }); _seenTtl = true; }
  const r = await c.updateOne({ _id: messageId }, { $setOnInsert: { ts: new Date(whenMs) } }, { upsert: true });
  return r.upsertedCount === 1; // first sighting → count it; else a dup/replay → skip
}
