// One-shot: split the conflated card. 6a2ce7b4 keeps ONLY the (strengthened) tool-call rule;
// the no-preamble/closing rule becomes its OWN new card, mapped to the same six subtypes and
// slotted right after the tool-call card in each (orderKey = sibling key + "1"). Backed up first.
// Usage (NODE_ENV=dev): node scripts/_prompt_split_noprose.mjs [--apply]
import { MongoClient, ObjectId } from "mongodb";
import dotenvFlow from "dotenv-flow";
dotenvFlow.config();

const { MONGO_URI, MONGO_DB = "yeschef" } = process.env;
const COLL = process.env.PROMPT_COLLECTION || "prompt_library";
const TOOLCALL_ID = new ObjectId("6a2ce7b4a816493790ff1c02");
const APPLY = process.argv.includes("--apply");

const TOOLCALL_RULE = `* The only functions/tools you may call are the ones provided to you for this step, and ONLY via the tool mechanism — NEVER by writing a {"name": ..., "parameters": ...} object into your message text. NEVER emit such an object for any name that is not one of those provided tools. Invented names like recipe_builder, recipe_generator, menu_interpreter, recipe_optimizer DO NOT EXIST — never name, call, propose, or describe calling them.
* Your deliverable is your MESSAGE CONTENT: output it directly as the requested YAML or text. Tools exist ONLY to look up information, never to return your answer — never wrap your answer in a function-call shape.`;

const NOPROSE_RULE = `* Output ONLY the deliverable, then the status block — NOTHING else. No preamble, no greeting, no "Here is the response", no "The final answer is", no notes, no description of what you did or what you assume, and no closing question or offer to continue. Begin your response immediately with the first key of the output template, and stop immediately after the status block.`;

const client = new MongoClient(MONGO_URI);
await client.connect();
const coll = client.db(MONGO_DB).collection(COLL);

const tc = await coll.findOne({ _id: TOOLCALL_ID });
if (!tc) { console.error("tool-call card not found"); process.exit(1); }
// New card sits just AFTER the tool-call card in each subtype: sibling order key + "1"
// (e.g. "r1" → "r11", which lex-sorts between "r1" and "r2").
const noproseMapping = Object.fromEntries(Object.entries(tc.mapping).map(([sub, k]) => [sub, `${k}1`]));

console.log("toolcall card → keep ONLY tool-call rule (drop the no-prose bullet)");
console.log("new no-prose card mapping:", JSON.stringify(noproseMapping));
console.log(`\n--- toolcall (new len ${TOOLCALL_RULE.length}) ---\n${TOOLCALL_RULE}`);
console.log(`\n--- noprose card (len ${NOPROSE_RULE.length}) ---\n${NOPROSE_RULE}`);

if (!APPLY) { console.log("\n(dry run — pass --apply)"); await client.close(); process.exit(0); }

const now = new Date();
const r1 = await coll.updateOne({ _id: TOOLCALL_ID }, { $set: { content: TOOLCALL_RULE, updatedAt: now } });
const ins = await coll.insertOne({
  content: NOPROSE_RULE,
  mapping: noproseMapping,
  active: true,
  modelOverride: tc.modelOverride ?? null,
  createdAt: now,
  updatedAt: now,
});
console.log(`\ntoolcall updated: modified=${r1.modifiedCount}`);
console.log(`noprose inserted: _id=${ins.insertedId}`);
await client.close();
process.exit(0);
