import { PubSub } from "@google-cloud/pubsub";
process.env.PUBSUB_EMULATOR_HOST = "127.0.0.1:8185";
const ps = new PubSub({ projectId: "yeschef-c572a" });
for (const n of ["sub_orchestrate_push","sub_llama3_1_8b_v1"]) {
  const [md] = await ps.subscription(n).getMetadata();
  console.log(n, JSON.stringify({push: md.pushConfig?.pushEndpoint, ack: md.ackDeadlineSeconds, topic: md.topic, dead: md.deadLetterPolicy}));
}
