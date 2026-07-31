// AJV request-body schemas for the /ai routes. Field lists match what every caller
// actually sends (yeschef app + dashboard) so additionalProperties:false rejects
// junk/injection without 400-ing legitimate requests. Nested config objects stay
// permissive ({ type: object }); the value is type-pinning the scalars + ids so a
// Mongo-operator object (e.g. {$ne:null}) can't arrive where a string is expected.

const OBJ = { type: "object" };

export const menuSchema = {
  type: "object",
  additionalProperties: false,
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
    location:            { type: "string", maxLength: 200 },
    jobId:               { type: "string", maxLength: 128 },
    fake:                { type: "boolean" },
    planId:              { type: "string", maxLength: 128 },  // ← reverse link to the Mongo meal_plan
    stepId:              { type: "string", maxLength: 128 },  // ← which plan step this build is for
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
