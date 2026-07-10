// AJV body validation for /ai routes, mirroring dnd-community-and-marketplace's
// validate middleware: a shared AJV with an `objectId` / `objectIdList` format so
// id-shaped fields can't carry Mongo operators or junk into a query. Use as a
// per-route Fastify preHandler: `{ preHandler: [requireAuth, validateBody(schema)] }`.
import Ajv from "ajv";

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const OBJECT_ID_LIST = /^([a-f0-9]{24})(,[a-f0-9]{24})*$/i;

const ajv = new Ajv({ allErrors: true, coerceTypes: false });
ajv.addFormat("objectId", (v) => typeof v === "string" && OBJECT_ID.test(v));
ajv.addFormat("objectIdList", (v) => typeof v === "string" && OBJECT_ID_LIST.test(v));

// Compile once per schema object (cached by reference).
const compiled = new WeakMap();
function validator(schema) {
  let v = compiled.get(schema);
  if (!v) { v = ajv.compile(schema); compiled.set(schema, v); }
  return v;
}

export function validateBody(schema) {
  const validate = validator(schema);
  return async (req, reply) => {
    if (req.raw.method === "OPTIONS") return;
    if (validate(req.body ?? {})) return;
    console.error("[validateBody]", req.routeOptions?.url, validate.errors);
    reply.code(400).send({ error: "Invalid request body" });
    return reply;
  };
}
