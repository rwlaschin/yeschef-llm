// /ai/steps — Step Library (Mongo `plan_library`, alongside the prompts).
//   GET  → list entries in plan order (lex `order`); the dashboard fetches this to render the list.
//   POST → mutate. body: { op: "create" | "update" | "delete", id?, doc? }
// The dashboard never writes Mongo directly; every mutation comes here. ids are the Mongo _id as a
// hex string (the dashboard keys rows on `id`); update is a partial $set merge.
import { ObjectId } from "mongodb";
import { getCollection } from "../../lib/mongo.js";

const COLL = "plan_library";

export async function list(_req, reply) {
  try {
    const col = await getCollection(COLL);
    const docs = await col.find({}).sort({ order: 1 }).toArray();
    return reply.send(docs.map(({ _id, ...rest }) => ({ id: String(_id), ...rest })));
  } catch (e) {
    console.error(`[ai/steps] list failed:`, e?.message);
    return reply.code(500).send({ error: e?.message || "step list failed" });
  }
}

export async function post(req, reply) {
  const { op, id, doc } = req.body || {};
  try {
    const col = await getCollection(COLL);
    if (op === "create") {
      const r = await col.insertOne({ ...(doc || {}), createdAt: new Date(), updatedAt: new Date() });
      return reply.send({ id: String(r.insertedId) });
    }
    if (op === "update") {
      if (!id) return reply.code(400).send({ error: "id required for update" });
      await col.updateOne({ _id: new ObjectId(id) }, { $set: { ...(doc || {}), updatedAt: new Date() } });
      return reply.send({ id });
    }
    if (op === "delete") {
      if (!id) return reply.code(400).send({ error: "id required for delete" });
      await col.deleteOne({ _id: new ObjectId(id) });
      return reply.send({ ok: true });
    }
    return reply.code(400).send({ error: `unknown op: ${op}` });
  } catch (e) {
    console.error(`[ai/steps] ${op} failed:`, e?.message);
    return reply.code(500).send({ error: e?.message || "step write failed" });
  }
}
