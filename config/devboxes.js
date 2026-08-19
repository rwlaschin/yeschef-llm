// THE DECLARED FLEET. config/devboxes.json is the single source of truth for which GPU devboxes may
// exist and what every name derived from one is; this module is its only reader on the ESM side.
// ecosystem.devbox.config.cjs reads the JSON directly because pm2 require()s it as CommonJS and this
// repo is "type": "module" — JSON is the one form both halves read with no build step and no second
// list to drift.
//
// PURE, like config/regions.js: no Mongo, no GCP, no dotenv, so a pm2 config load and a CLI both pay
// a file read and nothing else.
//
// A box's name is 001..004 and NOTHING ELSE. The names are validated here rather than at the moment
// `create` is typed, because a box created under a name nobody declared is invisible to pm2 and bills
// unattended — which is what happened on 2026-08-14.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const NAME_RE = /^00[1-4]$/;
const MAX_BOXES = 4;
// A reserved address is regional and cannot follow a box across a stockout rebuild — that mismatch is
// what manufactured four orphan reservations. The IP is ephemeral now, so a registry that names one
// is rejected rather than quietly re-enabling the model.
const BANNED_FIELDS = ["address", "addr", "ip", "staticIp"];

export const validate = (reg) => {
  const boxes = reg?.boxes;
  if (!boxes || typeof boxes !== "object") throw new Error(`config/devboxes.json: "boxes" must be an object.`);
  const names = Object.keys(boxes);
  if (names.length > MAX_BOXES) throw new Error(`config/devboxes.json declares ${names.length} boxes; at most ${MAX_BOXES} are permitted (001..004).`);
  for (const n of names) {
    if (!NAME_RE.test(n)) throw new Error(`Unknown devbox ${JSON.stringify(n)} — boxes are named 001..004.`);
    const banned = BANNED_FIELDS.find((f) => f in boxes[n]);
    if (banned) throw new Error(`Box ${n} declares "${banned}": devbox addresses are ephemeral, nothing is reserved.`);
  }
  return reg;
};

const REG = validate(JSON.parse(readFileSync(fileURLToPath(new URL("./devboxes.json", import.meta.url)), "utf8")));

export const L4_ZONES = REG.l4Zones;
// Read per call, not at import: a caller that loads its .env AFTER importing this module (devbox.js
// does) must still see an override from that file.
export const dnsSuffix = () => process.env.DEVBOX_DNS_SUFFIX || REG.dnsSuffix;
export const DEFAULTS = REG.defaults;
export const BOX_NAMES = Object.keys(REG.boxes).filter((n) => REG.boxes[n].enabled).sort();
export const ALL_BOX_NAMES = Object.keys(REG.boxes).sort();

export const boxDef = (name) => {
  if (!REG.boxes[name]) throw new Error(`Unknown devbox ${JSON.stringify(name)} — declared boxes are ${ALL_BOX_NAMES.join(", ")}.`);
  return { name, ...DEFAULTS, ...REG.boxes[name] };
};

// The non-throwing form, for the CLI verbs that operate on whatever VM actually exists: GCE is the
// authority on what is running, and a box that outlived its registry entry still has to be stoppable.
export const boxDefaults = (name) => (REG.boxes[name] ? boxDef(name) : { name, ...DEFAULTS });

// The VM name may diverge from the box name — a GCE instance cannot be renamed, so a rebuild under a
// different name is repaired by declaring it here, never by renaming the box.
export const vmOf = (name) => REG.boxes[name]?.vm || `yc-ollama-${name}`;
export const hostOf = (name) => `ollama-${name}.${dnsSuffix()}`;

// Rates are us-central1 on-demand references unless a region carries its own entry; isReference says
// which, so a us-east4 box is never presented as a measured price. Unknown machine → 0, never NaN.
export const rateFor = (machine, region) => {
  const r = REG.rates[machine];
  if (!r) return { rate: 0, isReference: false };
  return region in r ? { rate: r[region], isReference: false } : { rate: r.default, isReference: true };
};
