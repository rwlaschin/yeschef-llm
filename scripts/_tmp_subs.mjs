import { PubSub } from "@google-cloud/pubsub";
process.env.PUBSUB_EMULATOR_HOST = process.env.PUBSUB_EMULATOR_HOST || "127.0.0.1:8185";
const ps = new PubSub({ projectId: "yeschef-c572a" });
const [subs] = await ps.getSubscriptions();
for (const s of subs) console.log("SUB", s.name);
const [tops] = await ps.getTopics();
for (const t of tops) console.log("TOPIC", t.name);
