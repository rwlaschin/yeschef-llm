// One-shot: harden the cross-subtype output-contract prompt (no tool-call JSON in message,
// no preamble/closing chatter). Updates ONLY _id 6a2ce7b4a816493790ff1c02. Backed up first to
// .backups/. Usage (NODE_ENV=dev): node scripts/_prompt_apply_noprose.mjs [--apply]
import { MongoClient, ObjectId } from "mongodb";
import dotenvFlow from "dotenv-flow";
dotenvFlow.config();

const { MONGO_URI, MONGO_DB = "yeschef" } = process.env;
const COLL = process.env.PROMPT_COLLECTION || "prompt_library";
const ID = new ObjectId("6a2ce7b4a816493790ff1c02");
const APPLY = process.argv.includes("--apply");

const NEW_CONTENT = `* The only functions/tools you may call are the ones provided to you for this step, and ONLY via the tool mechanism — NEVER by writing a {"name": ..., "parameters": ...} object into your message text. NEVER emit such an object for any name that is not one of those provided tools. Invented names like recipe_builder, recipe_generator, menu_interpreter, recipe_optimizer DO NOT EXIST — never name, call, propose, or describe calling them.
* Your deliverable is your MESSAGE CONTENT: output it directly as the requested YAML or text. Tools exist ONLY to look up information, never to return your answer — never wrap your answer in a function-call shape.
* Output ONLY the deliverable, then the status block — NOTHING else. No preamble, no greeting, no "Here is the response", no "The final answer is", no notes, no description of what you did or what you assume, and no closing question or offer to continue. Begin your response immediately with the first key of the output template, and stop immediately after the status block.`;

const client = new MongoClient(MONGO_URI);
await client.connect();
const coll = client.db(MONGO_DB).collection(COLL);
const cur = await coll.findOne({ _id: ID });
if (!cur) { console.error("doc not found"); process.exit(1); }

console.log(`--- CURRENT (len ${cur.content.length}) ---\n${cur.content}\n`);
console.log(`--- NEW (len ${NEW_CONTENT.length}) ---\n${NEW_CONTENT}\n`);

if (!APPLY) { console.log("(dry run — pass --apply to write)"); await client.close(); process.exit(0); }

const res = await coll.updateOne({ _id: ID }, { $set: { content: NEW_CONTENT } });
console.log(`updated: matched=${res.matchedCount} modified=${res.modifiedCount}`);
await client.close();
process.exit(0);
