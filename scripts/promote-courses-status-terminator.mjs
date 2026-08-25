import { BSON, MongoClient, ObjectId } from "mongodb";
import dotenvFlow from "dotenv-flow";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TARGET_ID = "6a7dea88dff6312de743c22d";
const TARGET_NAME = "Courses status contract";
const OLD_PASS = "@@::PASS::@@";
const OLD_FAIL = "@@::FAIL:reason::@@";
const NEW_PASS = "@@::PASS;:&@";
const NEW_FAIL = "@@::FAIL:reason;:&@";
const OLD_DELIMITER_PROSE = "The REQUIRED DELIMITERS are the literal sequence @@:: at the start and ::@@ at the end. Between them put only PASS or FAIL:reason. Never put the deliverable or any other content inside the status block. Do not prefix it with a label. Output nothing after it.";
const NEW_DELIMITER_PROSE = "The REQUIRED DELIMITERS are the literal sequence @@:: at the start and ;:&@ at the end. Between them put only PASS or FAIL:reason. Never put the deliverable or any other content inside the status block. Do not prefix it with a label. Output nothing after it.";
const BACKUP_DIR = ".backup";

const count = (content, literal) => content.split(literal).length - 1;

export function promoteCoursesStatusTerminator(content) {
  if (typeof content !== "string") throw new TypeError("prompt content must be a string");

  const hits = {
    oldPass: count(content, OLD_PASS),
    oldFail: count(content, OLD_FAIL),
    newPass: count(content, NEW_PASS),
    newFail: count(content, NEW_FAIL),
    oldProse: count(content, OLD_DELIMITER_PROSE),
    newProse: count(content, NEW_DELIMITER_PROSE),
  };

  if (hits.oldPass === 1 && hits.oldFail === 1 && hits.oldProse === 1 && hits.newPass === 0 && hits.newFail === 0 && hits.newProse === 0) {
    return content.replace(OLD_PASS, NEW_PASS).replace(OLD_FAIL, NEW_FAIL).replace(OLD_DELIMITER_PROSE, NEW_DELIMITER_PROSE);
  }
  if (hits.oldPass === 0 && hits.oldFail === 0 && hits.oldProse === 0 && hits.newPass === 1 && hits.newFail === 1 && hits.newProse === 1) {
    return content;
  }

  const problems = [];
  if (hits.oldPass + hits.newPass !== 1) problems.push(`PASS contract count is ${hits.oldPass + hits.newPass}, expected 1`);
  if (hits.oldFail + hits.newFail !== 1) problems.push(`FAIL contract count is ${hits.oldFail + hits.newFail}, expected 1`);
  if (hits.oldProse + hits.newProse !== 1) problems.push(`delimiter prose count is ${hits.oldProse + hits.newProse}, expected 1`);
  if (!problems.length) problems.push("PASS and FAIL use different terminator styles");
  throw new Error(`refusing unexpected status contract: ${problems.join("; ")}`);
}

const activeCoursesQuery = {
  active: true,
  deleted: { $ne: true },
  isDeleted: { $ne: true },
  "mapping.courses": { $exists: true },
};

const encoded = (value) => BSON.EJSON.stringify(value, { relaxed: false });
const printPrompt = (label, content) => console.log(`\n===== ${label} =====\n${content}\n===== END ${label} =====`);

async function run() {
  dotenvFlow.config({ node_env: process.env.NODE_ENV || "dev" });
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");

  const commit = process.argv.includes("--commit");
  const rollbackAt = process.argv.indexOf("--rollback");
  const rollbackFile = rollbackAt >= 0 ? process.argv[rollbackAt + 1] : null;
  if (rollbackAt >= 0 && (!rollbackFile || rollbackFile.startsWith("--"))) {
    throw new Error("--rollback requires a backup file");
  }

  const client = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 30000 });
  await client.connect();
  try {
    const collection = client.db(process.env.MONGO_DB || "yeschef").collection("prompt_library");
    const targetId = new ObjectId(TARGET_ID);
    const target = await collection.findOne({ _id: targetId });
    if (!target) throw new Error(`target ${TARGET_ID} not found`);
    if (target.name !== TARGET_NAME) throw new Error(`target name is ${JSON.stringify(target.name)}, expected ${JSON.stringify(TARGET_NAME)}`);
    if (target.active !== true || target.deleted === true || target.isDeleted === true) throw new Error("target is not active and nondeleted");
    if (!target.mapping?.courses) throw new Error("target is not mapped to courses");
    if (typeof target.content !== "string") throw new Error("target content is not a string");

    if (rollbackFile) {
      const backup = BSON.EJSON.parse(fs.readFileSync(rollbackFile, "utf8"));
      if (String(backup.preimage?._id) !== TARGET_ID || backup.preimage?.name !== TARGET_NAME) throw new Error("backup is not for the Courses status contract");
      if (typeof backup.afterContent !== "string") throw new Error("backup has no CAS afterContent");
      printPrompt("CURRENT", target.content);
      printPrompt("ROLLBACK", backup.preimage.content);
      if (!commit) return console.log("\nDRY RUN — nothing written. Add --commit to roll back.");
      const result = await collection.updateOne(
        { _id: targetId, content: backup.afterContent },
        { $set: { content: backup.preimage.content } }
      );
      if (result.matchedCount !== 1) throw new Error("rollback CAS failed; current content differs from the backup's written content");
      const verified = await collection.findOne({ _id: targetId });
      if (verified?.content !== backup.preimage.content) throw new Error("rollback read-back verification failed");
      return console.log("\nROLLBACK VERIFIED");
    }

    const courses = await collection.find(activeCoursesQuery).sort({ _id: 1 }).toArray();
    const others = courses.filter((doc) => String(doc._id) !== TARGET_ID);
    if (others.length !== 5) throw new Error(`expected five other active Courses prompts, found ${others.length}`);
    const otherPreimages = new Map(others.map((doc) => [String(doc._id), encoded(doc)]));
    const afterContent = promoteCoursesStatusTerminator(target.content);

    console.log(`TARGET prompt_library/${TARGET_NAME} _id=${TARGET_ID}`);
    console.log(`MODE   ${commit ? "COMMIT" : "DRY RUN"}`);
    printPrompt("BEFORE", target.content);
    printPrompt("AFTER", afterContent);

    if (afterContent === target.content) return console.log("\nALREADY PROMOTED — nothing to write.");
    if (!commit) return console.log("\nDRY RUN — nothing written. Add --commit to apply.");

    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const backupPath = path.join(BACKUP_DIR, `courses-status-terminator-${Date.now()}.ejson`);
    fs.writeFileSync(backupPath, BSON.EJSON.stringify({ preimage: target, afterContent, takenAt: new Date() }, null, 2));
    console.log(`\nBACKUP ${backupPath}`);

    const result = await collection.updateOne(
      { _id: targetId, content: target.content },
      { $set: { content: afterContent } }
    );
    if (result.matchedCount !== 1) throw new Error("update CAS failed; target changed after it was read");

    const [verified, coursesAfter] = await Promise.all([
      collection.findOne({ _id: targetId }),
      collection.find(activeCoursesQuery).sort({ _id: 1 }).toArray(),
    ]);
    if (verified?.content !== afterContent) throw new Error("target read-back verification failed");
    for (const doc of coursesAfter) {
      if (String(doc._id) === TARGET_ID) continue;
      if (otherPreimages.get(String(doc._id)) !== encoded(doc)) throw new Error(`other Courses prompt changed: ${doc._id}`);
    }
    if (coursesAfter.length !== 6) throw new Error(`active Courses prompt count changed from 6 to ${coursesAfter.length}`);

    console.log("WRITE  matched=1");
    console.log("VERIFY target content matches and five sibling prompts are byte-identical");
    console.log(`UNDO   node scripts/promote-courses-status-terminator.mjs --rollback ${backupPath} --commit`);
  } finally {
    await client.close();
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  run().catch((error) => {
    console.error(`REFUSING: ${error.message}`);
    process.exitCode = 1;
  });
}
