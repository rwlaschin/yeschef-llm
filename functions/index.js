// ============================================================
// Plan Orchestrator — Firebase Functions v2 (Cloud Run). Owns /ai/*.
//
// Fastify-in-Firebase boilerplate mirrors the working setup in the other projects:
//   - @fastify/cors (with cached preflight)
//   - @fastify/multipart (forms / uploads)
//   - an `application/json` content-type parser that reads the body FIREBASE already
//     parsed (payload.body / payload.rawBody) — Firebase consumes the stream, so a
//     stream-reading parser hangs
//   - dispatch via `await app.ready(); app.routing(req, res)`
// Routes are lazy-imported on first hit (cheaper cold start than top-level imports).
// ============================================================

import { onRequest } from "firebase-functions/v2/https";
import { initializeApp, getApps } from "firebase-admin/app";
import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyMultipart from "@fastify/multipart";
import { lazy } from "./lib/lazy.js";

if (!getApps().length) initializeApp(); // ADC on Cloud Run

const FASTIFY_OPTS = { maxRequestHeadersSize: 32768 };
const MAX_CACHE_SECONDS = 60 * 60 * 24 * 30 * 12; // 12 months

const ai = Fastify(FASTIFY_OPTS);

ai.register(fastifyCors, {
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
  credentials: true,
  maxAge: MAX_CACHE_SECONDS,
  cacheControl: `public, max-age=${MAX_CACHE_SECONDS}`,
});

ai.register(fastifyMultipart, {
  attachFieldsToBody: true,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// OPTIONS preflight responses cacheable (override infra's Pragma: no-cache).
ai.addHook("onSend", async (request, reply, payload) => {
  if (request.raw.method === "OPTIONS") {
    reply.removeHeader("Pragma");
    reply.header("Cache-Control", `public, max-age=${MAX_CACHE_SECONDS}`);
  }
  return payload;
});

// Firebase pre-parses the JSON body and CONSUMES the request stream, so read what it
// gives us (payload.body, else payload.rawBody) — a stream-reading parser would hang.
ai.addContentTypeParser("application/json", {}, (req, payload, done) => {
  req.rawBody = payload.rawBody;
  if (payload.body != null) {
    done(null, payload.body);
  } else if (payload.rawBody) {
    try { done(null, JSON.parse(payload.rawBody.toString("utf8"))); } catch (e) { done(e); }
  } else {
    done(null, null);
  }
});

// ---- Route table (lazy) ------------------------------------
ai.post("/plan", lazy(() => import("./entry/ai/plan.js"), "post"));    // UI/YesChef launch a plan
ai.post("/menu", lazy(() => import("./entry/ai/menu.js"), "post"));    // UI: compose a Menu Plan (no planner) → run step 0
ai.get("/steps", lazy(() => import("./entry/ai/steps.js"), "list"));   // Step Library list (Mongo plan_library)
ai.post("/steps", lazy(() => import("./entry/ai/steps.js"), "post"));  // Step Library writes (Mongo plan_library)
// Re-run an EXISTING plan without re-running the planner (hard-deletes the right run range,
// server-side). Static /resume/plan resolves before the :step param routes (Fastify precedence).
ai.post("/rebuild", lazy(() => import("./entry/ai/resume.js"), "rebuild"));    // DEV: re-parse existing planner output → run step 0 (no planner re-run)
ai.post("/resume/plan", lazy(() => import("./entry/ai/resume.js"), "plan"));  // wipe all step runs, run step 0
ai.post("/resume/:step", lazy(() => import("./entry/ai/resume.js"), "next")); // wipe >N, publish N's finish
ai.post("/run/:step", lazy(() => import("./entry/ai/resume.js"), "run"));     // DEBUG: run ONE step isolated (report:null, no cascade)
ai.post("/events", lazy(() => import("./entry/ai/events.js"), "post")); // `orchestrate` topic push
ai.get("/health", () => ({ status: "ok" }));                            // liveness probe (dashboard health panel)

ai.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "Not found" }));

// Exported as `ai` → public path prefix /ai (function name stripped; routes are /plan, /events).
const _ai = onRequest(
  { timeoutSeconds: 3600, cpu: 1, memory: "512MiB", region: "us-central1" },
  async (req, res) => {
    try {
      await ai.ready();
      ai.routing(req, res);
    } catch (error) {
      console.error("Error handling AI request:", error);
      res.status(400).send({ error: "Bad request" });
    }
  }
);
export { _ai as ai };

// Create the `orchestrate` topic + push subscription on startup (idempotent).
if (process.env.K_SERVICE || process.env.FUNCTIONS_EMULATOR === "true") {
  import("./lib/pubsub.js")
    .then(({ configurePubSub }) => configurePubSub())
    .catch((e) => console.error("[orchestrator] pubsub setup failed:", e.message));
}
