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
