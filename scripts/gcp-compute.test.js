import { test } from "node:test";
import assert from "node:assert/strict";

import { createComputeAdapter, isStockoutError } from "../dashboard/server/utils/gcp-compute.js";

test("Equivalence partitioning: constructs official Compute clients with ADC and the configured project", () => {
  const constructions = [];
  class InstancesClient {
    constructor(options) { constructions.push(["instances", options]); }
  }
  class FirewallsClient {
    constructor(options) { constructions.push(["firewalls", options]); }
  }

  createComputeAdapter({ projectId: "yeschef-test", InstancesClient, FirewallsClient });

  assert.deepEqual(constructions, [
    ["instances", {}],
    ["firewalls", {}],
  ]);
});

test("Error guessing: adapter source has no interactive gcloud authentication dependency", async () => {
  const source = await import("node:fs").then(({ readFileSync }) => readFileSync(new URL("../dashboard/server/utils/gcp-compute.js", import.meta.url), "utf8"));

  assert.doesNotMatch(source, /gcloud\s+auth|print-access-token|auth login/);
});

test("Domain analysis: create waits for the Compute long-running operation before reporting success", async () => {
  const calls = [];
  const adapter = createComputeAdapter({
    projectId: "yeschef-test",
    instancesClient: {
      async insert(request) {
        calls.push(["insert", request.zone]);
        return [{ async promise() { calls.push(["wait", request.zone]); } }];
      },
    },
    firewallsClient: {},
  });

  await adapter.createInstance({ zone: "us-west4-a", instanceResource: { name: "yc-ollama-001" } });

  assert.deepEqual(calls, [["insert", "us-west4-a"], ["wait", "us-west4-a"]]);
});

test("Equivalence partitioning: classifies zone resource exhaustion as a stockout", () => {
  assert.equal(isStockoutError({ code: 409, message: "ZONE_RESOURCE_POOL_EXHAUSTED: no resources available" }), true);
});

test("Regression: classifies the Compute API stockout status text returned for exhausted L4 capacity", () => {
  const error = {
    code: 409,
    message: "The zone is experiencing resource stockout. state: STOCKOUT, sub-state: STOCKOUT, resource type: compute",
  };

  assert.equal(isStockoutError(error), true);
});

test("Equivalence partitioning: does not classify permission denial as a stockout", () => {
  assert.equal(isStockoutError({ code: 403, message: "Permission denied" }), false);
});

test("Equivalence partitioning: does not classify authentication failure as a stockout", () => {
  assert.equal(isStockoutError({ code: 401, message: "Invalid authentication credentials" }), false);
});

test("Regression: an existing firewall keeps prior operators when adding the current IP", async () => {
  const patches = [];
  const adapter = createComputeAdapter({
    projectId: "yeschef-test",
    instancesClient: {},
    firewallsClient: {
      async get() { return [{ sourceRanges: ["198.51.100.1/32"] }]; },
      async patch(request) {
        patches.push(request.firewallResource.sourceRanges);
        return [{ async promise() {} }];
      },
    },
  });

  await adapter.ensureFirewall({ name: "yc-ollama-allow", port: 11434, tag: "ollama-devbox", sourceRanges: ["203.0.113.2/32"] });

  assert.deepEqual(patches, [["198.51.100.1/32", "203.0.113.2/32"]]);
});

// THE REAL FAILURE, 2026-09-01: \`start 001\` printed "us-west1-a: CREATED" and waited 10 minutes for
// Ollama on a VM that was never allocated. GCE finished the insert operation DONE carrying an L4
// STOCKOUT error, and a DONE-with-error operation RESOLVES rather than rejecting — so wait() saw no
// throw. createInstance MUST surface it, or startDevbox never reaches its stockout branch.
test("Domain analysis: an operation that finishes DONE carrying an error is thrown, not reported as success", async () => {
  const adapter = createComputeAdapter({
    projectId: "yeschef-test",
    instancesClient: { async insert() { return [{ name: "operation-1787-stockout", async promise() {} }]; } },
    firewallsClient: {},
    ZoneOperationsClient: class {
      async wait({ operation }) {
        return [{ name: operation, status: "DONE", error: { errors: [{ message: "The zone 'projects/p/zones/us-west1-a' does not have enough resources available to fulfill the request. 'NULL:0/NULL:0/NULL:0 (state:STOCKOUT, sub-state:STOCKOUT, resource type:compute)'." }] } }];
      }
    },
  });

  await assert.rejects(
    () => adapter.createInstance({ zone: "us-west1-a", instanceResource: { name: "yc-ollama-001" } }),
    (err) => {
      assert.match(err.message, /state:STOCKOUT/);
      assert.equal(isStockoutError(err), true); // this is what routes startDevbox to the next zone
      return true;
    },
  );
});

