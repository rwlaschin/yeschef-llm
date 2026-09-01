// Tell the plan's CREATOR their build is done — from the server, when the job goes terminal.
//
// The build runs on workers for many minutes, so the app tells the chef to go do something else
// ("a watched pot never boils"). Only a write from here keeps that promise: the browser that
// launched it is closed, so anything client-side notifies nobody.
//
// The creator is `meal_plans.userId` — set to the creating ENTITY's id by POST /api/meal_plan, which
// is the only place a plan is created, so every plan already carries it. No new field.
//
// Writes the same doc shape as yeschef's lib/firebase/collab.ts notify(), so the live bell renders
// it unchanged.
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { ObjectId } from "mongodb";
import { getCollection } from "../../../lib/mongo.js";

// A few phrasings so the same sentence doesn't greet a chef every single build.
const DONE = [
  "The pot boiled — your menu is ready.",
  "Back already? Good timing — your menu is ready.",
  "Your menu is ready. Thanks for not watching the pot.",
];
const FAILED = [
  "Your menu build stopped early — it needs another look.",
  "The build didn't finish cleanly. Have a look when you can.",
];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// Returns true when a notification was written. Never throws for a missing creator/plan — no
// notification is better than notifying the wrong person.
export async function notifyBuildComplete(job, ok, deps = {}) {
  // Only a menu/recipes build notifies; a tquery or a bare Request page job has no plan to point at.
  if (job?.type !== "menu" || !job.planId || !ObjectId.isValid(job.planId)) return false;

  const plans = deps.plans || (await getCollection("meal_plans"));
  const plan = await plans.findOne({ _id: new ObjectId(job.planId) }, { projection: { userId: 1 } });
  const entityId = plan?.userId ? String(plan.userId) : "";
  if (!entityId) return false;

  const text = ok ? pick(DONE) : pick(FAILED);
  const db = deps.db || getFirestore();
  await db.collection("notifications").doc(entityId).collection("items").add({
    type: ok ? "step_ready" : "step_failed",
    anchor: { type: "step", planId: String(job.planId), stepId: "recipes", label: "Recipes" },
    fromEntityId: "system",
    fromName: "Remy",
    text,
    content: [ok ? "**Your menu is ready**" : "**Your menu build needs attention**", text],
    read: false,
    createdAt: FieldValue.serverTimestamp(),
  });
  return true;
}
