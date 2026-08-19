import { test } from "node:test";
import assert from "node:assert/strict";
import { validate, BOX_NAMES, ALL_BOX_NAMES, boxDef, boxDefaults, vmOf, hostOf, rateFor, L4_ZONES } from "./devboxes.js";

// The declared set is what makes a name legal. A box created under an undeclared name is invisible to
// pm2 and bills unattended, so every one of these throws is a bill that does not happen.
test("boxDef throws for a letter name, naming the declared set", () => {
  assert.throws(() => boxDef("a"), /Unknown devbox "a".*001/s);
});

test("boxDef throws for a number outside 001..004", () => {
  assert.throws(() => boxDef("005"), /Unknown devbox "005"/);
  assert.throws(() => boxDef("1"), /Unknown devbox "1"/);
});

test("a registry of 5 boxes throws", () => {
  const five = { boxes: { "001": {}, "002": {}, "003": {}, "004": {}, "005": {} } };
  assert.throws(() => validate(five), /declares 5 boxes; at most 4/);
});

test("a key outside 001..004 throws even when the registry is small", () => {
  assert.throws(() => validate({ boxes: { a: {} } }), /Unknown devbox "a" — boxes are named 001\.\.004/);
  assert.throws(() => validate({ boxes: { "005": {} } }), /Unknown devbox "005"/);
});

test("a box declaring a reserved address is rejected — addresses are ephemeral", () => {
  for (const f of ["address", "addr", "ip", "staticIp"]) {
    assert.throws(() => validate({ boxes: { "001": { [f]: "34.10.0.1" } } }), /ephemeral/);
  }
});

test("the shipped registry declares 001..004 and enables only 001", () => {
  assert.deepEqual(ALL_BOX_NAMES, ["001", "002", "003", "004"]);
  assert.deepEqual(BOX_NAMES, ["001"]);
});

test("names derive from the box number, not from a second list", () => {
  assert.equal(vmOf("002"), "yc-ollama-002");
  assert.equal(hostOf("002"), "ollama-002.dev.yeschef.life");
});

test("a vm override renames only the VM; the host name stays conventional", () => {
  assert.equal(validate({ boxes: { "001": { vm: "yc-ollama-legacy" } } }).boxes["001"].vm, "yc-ollama-legacy");
  // the shipped registry declares no override, so both names follow the convention
  assert.equal(vmOf("001"), "yc-ollama-001");
  assert.equal(hostOf("001"), "ollama-001.dev.yeschef.life");
});

test("DEVBOX_DNS_SUFFIX overrides the suffix at call time", () => {
  const prev = process.env.DEVBOX_DNS_SUFFIX;
  process.env.DEVBOX_DNS_SUFFIX = "dev.example.test";
  try { assert.equal(hostOf("003"), "ollama-003.dev.example.test"); }
  finally { prev === undefined ? delete process.env.DEVBOX_DNS_SUFFIX : (process.env.DEVBOX_DNS_SUFFIX = prev); }
});

test("every box carries its own zone order, and no two lead with the same zone", () => {
  const leads = ALL_BOX_NAMES.map((n) => boxDef(n).zones[0]);
  assert.equal(new Set(leads).size, leads.length);
  for (const n of ALL_BOX_NAMES) {
    for (const z of boxDef(n).zones) assert.equal(L4_ZONES.includes(z), true, `${n}: ${z} is not an L4 zone`);
  }
});

test("us-central1-f is absent from L4_ZONES — it carries no L4 at all", () => {
  assert.equal(L4_ZONES.includes("us-central1-f"), false);
  assert.equal(L4_ZONES.length, 13);
});

test("a rate with no region entry resolves to the us-central1 reference and says so", () => {
  assert.deepEqual(rateFor("g2-standard-8", "us-central1"), { rate: 0.85, isReference: true });
  assert.deepEqual(rateFor("g2-standard-24", "us-east4"), { rate: 2.15, isReference: true });
});

test("an unknown machine type bills 0, never NaN in a total", () => {
  const { rate } = rateFor("n1-standard-1", "us-central1");
  assert.equal(rate, 0);
  assert.equal(Number.isNaN(rate + 1), false);
});

test("boxDefaults answers for an undeclared name so an orphan VM stays operable", () => {
  assert.equal(boxDefaults("legacy").machine, "g2-standard-8");
  assert.equal(boxDefaults("001").zones[0], "us-east4-c");
});
