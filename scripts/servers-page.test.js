import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(ROOT, "../dashboard/pages/servers.vue"), "utf8");

function functionBody(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists in servers.vue`);

  const brace = source.indexOf("{", start);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not find the end of ${name}`);
}

test("Equivalence partitioning: a script log with a stored timestamp passes that timestamp to the device log instead of using receipt time", () => {
  const body = functionBody("addScriptLine");

  assert.match(body, /addDeviceLog\([^;]*\bl\.ts\b[^;]*\)/s);
});

test("Boundary and domain analysis: merged cloud and device logs are ordered by timestamp and then arrival sequence", () => {
  const declaration = source.match(/const visibleDeviceLogs = computed\(\(\) => \{([\s\S]*?)\n\}\)/)?.[1] || "";

  assert.match(declaration, /\.sort\([^)]*(?:timestamp|ts)[^)]*(?:sequence|seq|arrival)[^)]*\)/s);
});

test("Error guessing: cloud logs retain their source timestamp for chronological merging with historical script logs", () => {
  const body = functionBody("appendCloudLines");

  assert.match(body, /(?:timestamp|ts)\s*:\s*l\.ts/);
});

test("Error guessing: device logs retain a machine-sortable source timestamp separate from their display time", () => {
  const body = functionBody("addDeviceLog");

  assert.match(body, /(?:timestamp|ts)\s*:/);
});

test("Boundary value analysis: a historical log renders an explicit calendar date while a same-day log may render time only", () => {
  const logRow = source.match(/<div v-for="\(log, idx\) in visibleDeviceLogs"[\s\S]*?<\/div>/)?.[0] || "";

  assert.doesNotMatch(logRow, /\{\{\s*log\.time\s*\}\}/);
  assert.match(source, /toLocaleDateString\s*\(/);
  assert.match(source, /(?:toDateString\s*\(\)|getFullYear\s*\(\))[\s\S]{0,300}(?:toDateString\s*\(\)|getFullYear\s*\(\))/);
});

test("Domain analysis: a ready terminal event requests a fleet refresh even when startupProgress is already null", () => {
  const body = functionBody("applyProgress");
  const terminalBranch = body.match(/if \(terminal\) \{([\s\S]*?)\n\s*continue/)?.[1] || "";

  assert.match(terminalBranch, /if \(box\.startupProgress\)\s*\{\s*box\.startupProgress\s*=\s*null\s*\}\s*fetchFleet\(\)/s);
});

test("Combinatorial testing: a failed terminal event uses the same unconditional fleet-refresh path as ready", () => {
  const body = functionBody("applyProgress");
  const terminalBranch = body.match(/if \(terminal\) \{([\s\S]*?)\n\s*continue/)?.[1] || "";

  assert.match(body, /const terminal\s*=\s*p\s*&&\s*\(p\.phase\s*===\s*['"]ready['"]\s*\|\|\s*p\.phase\s*===\s*['"]failed['"]\)/);
  assert.match(terminalBranch, /if \(box\.startupProgress\)\s*\{\s*box\.startupProgress\s*=\s*null\s*\}\s*fetchFleet\(\)/s);
});

test("Boundary value analysis: one refresh arriving during an in-flight fetch is queued instead of dropped", () => {
  const body = functionBody("fetchFleet");

  assert.match(body, /if \(inFlightFetch\)\s*\{[^}]*queued[^}]*return[^}]*\}/s);
});

test("Combinatorial testing: many refreshes arriving during an in-flight fetch collapse into one bounded follow-up", () => {
  const body = functionBody("fetchFleet");

  assert.match(body, /finally\s*\{[\s\S]*inFlightFetch\s*=\s*false[\s\S]*if \([^)]*queued[^)]*\)[\s\S]*queued\s*=\s*false[\s\S]*fetchFleet\(\)/s);
});

test("Performance domain analysis: sorted boxes use constant-time activity membership inside the comparator", () => {
  const declaration = source.match(/const sortedBoxes = computed\(\(\) => \{([\s\S]*?)\n\}\)/)?.[1] || "";

  assert.doesNotMatch(declaration, /activeBoxes\.value\.includes\s*\(/);
  assert.match(source, /new Set\s*\([^)]*activeBoxes\.value/s);
  assert.match(declaration, /\.has\s*\(/);
});

test("Performance and equivalence partitioning: cloud log ingestion accepts only explicit box tokens and performs constant-time map lookup", () => {
  const body = functionBody("appendCloudLines");

  assert.doesNotMatch(body, /boxes\.value\.find\s*\(/);
  assert.match(source, /new Map\s*\([^)]*boxes\.value/s);
  assert.match(body, /yc-ollama-[^/\n]*devbox-|devbox-[^/\n]*yc-ollama-/);
  assert.match(body, /\\\[[^/\n]*\\d[^/\n]*\\\]/);
  assert.doesNotMatch(body, /\\b\s*\(?\s*\\d\{1,3\}\s*\)?\s*\\b/);
  assert.match(body, /padStart\s*\(\s*3\s*,\s*['"]0['"]\s*\)/);
  assert.match(body, /\.get\s*\(/);
});

test("Contract: the phase label table renders preflight startup progress in user-facing language", () => {
  const labels = source.match(/const PHASE_LABEL = \{([\s\S]*?)\n\}/)?.[1] || "";

  assert.match(labels, /preflight\s*:/);
});
