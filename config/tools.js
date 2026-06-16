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
];
