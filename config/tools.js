// config/tools.js — the implemented LLM tool definitions. A tool is NOT a model; it lives in its own
// file. SINGLE source of truth for the real tools — the PLANNER's tool list (via toolLine), the
// worker's executable tool defs, and the dashboard's per-step Tools picker are all built from this,
// until the `llmtools` collection is populated. Descriptions are written to make WHEN and HOW to use
// each tool unmistakable (the primary lever for the model using tools correctly).

export const DEFAULT_TOOLS = [
  {
    name: "web_search",
    description:
      "Search the web and get back a short list of result snippets (title, url, and a brief excerpt) — NOT full pages. " +
      "WHEN TO USE: to DISCOVER sources or look up facts a step needs but doesn't already have — current data, regulations, prices, product or option lists — anything not in the step's instructions or prior-step context. " +
      "WHEN NOT TO USE: do not use it to read a page whose URL you already have — use web_fetch for that. " +
      "Returns only the top few results, so make the query specific.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query. Be specific — include the key terms, names, and any constraints, e.g. \"CMS 42 CFR 483.60 institutional patient feeding requirements\"." },
        max_results: { type: "number", description: "How many results to return. Keep it small (a few is plenty); the system caps it. Omit to use the default." },
      },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description:
      "Fetch and read the FULL text of ONE specific web page. " +
      "WHEN TO USE: whenever you already have an exact URL to read — a menu, a source document, an article, a link given in the step's instructions. Use this INSTEAD of web_search any time a concrete URL is provided. " +
      "It reads one page per call; call it again for another URL.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The exact, full URL to fetch, including the https:// scheme. One page per call." },
      },
      required: ["url"],
    },
  },
  {
    // Inventory step ONLY. The model COPIES residents + the diet distribution + the day's recipes from
    // its prompt (it does NO math); the system normalizes the names and scales each per-serving amount
    // by how many residents are on that recipe's diet, and returns the rows. NOTE: runs in the worker →
    // only works on a RAW model tier (not the OpenClaw gateway), so pin the inventory step to a raw model.
    name: "normalize_ingredients",
    description:
      "Build the day's inventory. COPY the numbers and recipes from your prompt — do NOT compute anything. " +
      "Pass `residents` and the diet `diets` distribution (both stated in your instructions), and `recipes` " +
      "(the day's menu, grouped by diet, with each ingredient's per-serving amount). Copy names/amounts/units " +
      "EXACTLY — do NOT merge, rename, round, or multiply. The system normalizes the names and scales each " +
      "per-serving amount by how many residents are on that recipe's diet, and returns the inventory rows.",
    parameters: {
      type: "object",
      properties: {
        residents: { type: "number", description: "Total residents, copied from your instructions (e.g. 300)." },
        diets: {
          type: "array",
          description: "The diet distribution, copied from your instructions (e.g. renal 2%, no-sodium 40%, regular 58%).",
          items: {
            type: "object",
            properties: {
              diet: { type: "string", description: "Diet name, e.g. \"renal\"." },
              pct: { type: "number", description: "That diet's share, as written (e.g. 2 for 2%)." },
            },
            required: ["diet", "pct"],
          },
        },
        recipes: {
          type: "array",
          description: "Every recipe for this day, grouped by diet.",
          items: {
            type: "object",
            properties: {
              diet: { type: "string", description: "Which diet this recipe is for, e.g. \"renal\"." },
              items: {
                type: "array",
                description: "This recipe's ingredient lines, copied verbatim.",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string", description: "Ingredient name exactly as written. Do not simplify or merge." },
                    amount: { type: "number", description: "The PER-SERVING amount as written (e.g. 0.5 for ½)." },
                    unit: { type: "string", description: "The serving unit as written (e.g. \"cup\", \"slice\", \"each\")." },
                  },
                  required: ["name", "amount", "unit"],
                },
              },
            },
            required: ["diet", "items"],
          },
        },
      },
      required: ["residents", "diets", "recipes"],
    },
  },
  // A fresh agent on a clean context. Generic: the CALLING model supplies the ENTIRE prompt, so
  // this tool carries no task, no criteria and no wording of its own — nothing here or in
  // worker/tools/subagent.js says what the agent is for.
  {
    name: "sub_agent",
    description:
      "Runs a prompt in a fresh context with no history. Use when a task must not be influenced by the current conversation, the reasoning so far, or any output already produced — an independent check of work this session generated, a second answer to compare against, or a task whose result should stand on its own. The agent sees only the prompt it is given.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The complete prompt for the fresh agent — the task AND the material, written out in full. It has no other context." },
      },
      required: ["prompt"],
    },
  },
  // Storage OUTSIDE the model's context that it can rewrite and search. TWO measured failures, one
  // tool: (1) a stream cannot erase — a diet audit emitted "Lemon — strikes: low-sodium", could not
  // retract it, and carried it to the final row; a write that overwrites IS the erasure. (2) A
  // payload does not fit context — 347,790 chars left 4 tokens of the real prompt; the buffer holds
  // it and hands back one window at a time.
  // NO KEYS CROSS THIS BOUNDARY: the same model wrote "Almonds:nut", "Almonds:starch" and
  // "Almonds:nuts" across three runs, so it cannot hold an identifier. It addresses data by the
  // WORDS it wrote (query) and by continuing (read). The description says what each verb DOES;
  // what to conclude from a result is the calling prompt's business, not this tool's.
  {
    name: "memory_buffer",
    description:
      "A string scratchpad for recording and retrieving internal thinking and data that is not part of the final output. Use when working data would expand the context too much, dilute attention, or leak into the answer — and when a value needs to be held and verified before it is committed. Anything held here can be retrieved, tested, and rewritten; the output stream cannot. For example, computing 1 + 1 and storing 3, then retrieving it, testing whether 3 = 1 + 1, getting no, redoing the math, replacing 3 with 2, and only then putting \"1 + 1 = 2\" in the output. " +
      "Put a value in it as soon as you produce one, before you write anything to the output. Retrieve it to check it. If the check fails, write the corrected value in its place — a replacement leaves nothing of the earlier one behind. " +
      "Only put a value in the output once you have checked it. What you have written to the output cannot be retrieved, tested, or replaced.",
    parameters: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["write", "read", "query", "erase"],
          description: "query: find stored text by the words in `match`; returns one 400-character window centred on the match, and says if another entry matched too — repeat the same words to walk to the next one. read: the next 400 characters of the entry you are on, and whether more remains; with nothing open it starts on the entry written most recently. It never wraps and entries cannot be listed. write: store `text`, or replace an entry. erase: delete entries.",
        },
        text: { type: "string", description: "write only: the whole text to store, not a patch. Its FIRST LINE — up to the first colon, em dash, hyphen, pipe or tab — is the key, so a write repeating that first line replaces the earlier entry (e.g. writing \"Lemon — strikes: none\" replaces \"Lemon — strikes: low-sodium\"). Make the first line name what the entry is about. Nothing else is ever removed and there is no size limit." },
        match: { type: "string", description: "query and erase: plain words you expect to appear in the stored text. Words and their endings only — `dessert` finds `desserts`. A single mistyped letter is corrected and the corrected word is reported back, but synonyms do not match, so `meat free` misses text saying `vegetarian`. On erase, EVERY entry these words match is deleted and there is no preview; omit `match` to drop only the entry you have been reading." },
        restart: { type: "boolean", description: "read only: true starts the entry you are reading again from its beginning, instead of continuing after the last window." },
      },
      required: ["op"],
    },
  },
];
