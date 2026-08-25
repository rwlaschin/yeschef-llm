// AJV request-body schemas for the /ai routes. Field lists match what every caller
// actually sends (yeschef app + dashboard) so additionalProperties:false rejects
// junk/injection without 400-ing legitimate requests. Nested config objects stay
// permissive ({ type: object }); the value is type-pinning the scalars + ids so a
// Mongo-operator object (e.g. {$ne:null}) can't arrive where a string is expected.

const OBJ = { type: "object" };

export const menuSchema = {
  type: "object",
  additionalProperties: false,
  // A build with no caller or company is not a build. Enforced HERE so the route handler never
  // re-checks: an empty body used to validate, and the handler's own guard was the only thing
  // standing between it and a composed plan attributed to nobody.
  required: ["userId", "companyId"],
  properties: {
    userId:              { type: "string", maxLength: 128 },
    companyId:           { type: "string", maxLength: 128 },
    values:              OBJ,
    duration:            OBJ,
    residents:           { type: "number", minimum: 0, maximum: 1_000_000 },
    flags:               OBJ,
    enabled:             OBJ,
    dietWeights:         OBJ,
    proteins:            OBJ,  // per-slot grid proteins (normDiet → day → mealtime → {type,cut}) — seeds the recipes build so recipes mirror the grid
    costTier:            { type: "string", maxLength: 100 },
    costTierDescription: { type: "string", maxLength: 4000 },
    addedProteins:       { type: "array", maxItems: 100, items: { type: "string", maxLength: 120 } },  // chef-typed proteins the categorization step must also classify
    // The chef's arranged protein list from the setup page. The CUT is what decides the diet
    // ("Pork | bacon" is not "Pork | loin"), so it rides beside the protein rather than fused into it.
    proteinWeights: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["protein"],
        properties: {
          protein: { type: "string", maxLength: 120 },
          cut:     { type: "string", maxLength: 120 },
          diets:   { type: "array", maxItems: 50, items: { type: "string", maxLength: 120 } },
          weight:  { type: "number", minimum: 0, maximum: 100 },
        },
      },
    },
    location:            { type: "string", maxLength: 200 },
    jobId:               { type: "string", maxLength: 128 },
    fake:                { type: "boolean" },
    // Course position → dishes per meal ({ appetizer: 3, entree: 2, side: 3 }). Keys are :CourseType
    // slugs, so the vocabulary is data: validate the shape, not an enum that would need a deploy per
    // new course. A count is 0 (course not served at all — how the UI removes one) or 2–7 (the chef's
    // selectable range); 1 is not a menu, so it is not expressible.
    courseCounts:        { type: "object", additionalProperties: { type: "integer", anyOf: [{ const: 0 }, { minimum: 2, maximum: 7 }] } },
    planId:              { type: "string", maxLength: 128 },  // ← reverse link to the Mongo meal_plan
    stepId:              { type: "string", maxLength: 128 },  // ← which plan step this build is for
    // Client-minted correlation id, so a request can be joined browser → orchestrator → worker.
    // The jobId is minted server-side and only reaches the browser in the response, so it cannot
    // correlate the request going IN. Hardened to the leaf (not a bare object) — this is the only
    // key callers may send, per the boundary-validation rule.
    metadata:            {
      type: "object",
      additionalProperties: false,
      properties: { clientRequestId: { type: "string", maxLength: 128 } },
    },
  },
};

export const planSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    userId:     { type: "string", maxLength: 128 },
    companyId:  { type: "string", maxLength: 128 },
    userPrompt: { type: "string", maxLength: 20000 },
    model:      { type: "string", maxLength: 128 },
    metadata:   OBJ,
  },
};

export const querySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    query:       { type: "string", maxLength: 20000 },
    context:     {},                       // free-form
    history:     { type: "array" },
    userId:      { type: "string", maxLength: 128 },
    companyId:   { type: "string", maxLength: 128 },
    companyName: { type: "string", maxLength: 256 },
    fake:        { type: "boolean" },
    style:       { type: "string", maxLength: 64 },
    subtype:     { type: "string", maxLength: 64 },
    type:        { type: "string", maxLength: 64 },
    model:       { type: "string", maxLength: 128 },  // topic override; resolveTopic validates against MODELS
  },
};

// /tquery — a caller-composed TASK LIST. Deliberately NARROWER than querySchema: there is no
// userId/companyId here at all (identity comes from the verified token, so accepting the fields
// would only invite a caller to think they set them), and `type` is not a caller concern.
// tquery.js re-checks every subtype against SUBTYPES — maxLength alone is not the guard.
export const tquerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["tasks"],
  properties: {
    tasks: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        // `subtype` is OPTIONAL: omitted means `task`, the general case for a task list. A caller
        // opts IN to a specialized agent kind (tquery.js DEFAULT_SUBTYPE).
        required: ["query"],
        properties: {
          subtype: { type: "string", maxLength: 64 },
          query:   { type: "string", maxLength: 20000 },
          style:   { type: "string", maxLength: 64 },
        },
      },
    },
    fake:  { type: "boolean" },   // ignored in production (isProdLike) — see tquery.js
    model: { type: "string", maxLength: 128 },  // topic override; resolveTopic validates it
  },
};

export const stepsWriteSchema = {
  type: "object",
  additionalProperties: false,
  required: ["op"],
  properties: {
    op:  { type: "string", enum: ["create", "update", "delete"] },
    id:  { type: "string", format: "objectId" },   // used in new ObjectId(id) downstream
    doc: OBJ,
  },
};

// /resume/plan, /resume/:step, /run/:step, /rebuild — all take just a jobId.
export const jobIdSchema = {
  type: "object",
  additionalProperties: false,
  required: ["jobId"],
  properties: { jobId: { type: "string", maxLength: 128 } },
};
