import { test, describe } from "node:test";
import assert from "node:assert";
import { buildStandardMessages, formatRecipeYaml } from "./query.js";

describe("buildStandardMessages", () => {
  test("uses type prompt when no subtype is provided", async () => {
    const payload = { type: "query", query: "Hello" };
    const context = "context string";
    const deps = {
      systemPromptFor: async (t) => t === "query" ? "Base System Prompt" : null,
      buildMessages: (sys, q, c) => [{ role: "system", content: sys }, { role: "user", content: q }]
    };

    const messages = await buildStandardMessages(payload, context, deps);
    assert.deepStrictEqual(messages, [
      { role: "system", content: "Base System Prompt" },
      { role: "user", content: "Hello" }
    ]);
  });

  test("concatenates subtype prompt if provided", async () => {
    const payload = { type: "query", subtype: "recipe", query: "Chicken" };
    const context = "context string";
    const deps = {
      systemPromptFor: async (t) => {
        if (t === "query") return "Base Prompt";
        if (t === "recipe") return "Recipe Prompt";
        return null;
      },
      buildMessages: (sys, q, c) => [{ role: "system", content: sys }, { role: "user", content: q }]
    };

    const messages = await buildStandardMessages(payload, context, deps);
    assert.deepStrictEqual(messages, [
      { role: "system", content: "Base Prompt\n\nRecipe Prompt" },
      { role: "user", content: "Chicken" }
    ]);
  });

  test("handles subtype when subtype prompt is null (missing from DB)", async () => {
    const payload = { type: "query", subtype: "fake_subtype", query: "Apple" };
    const context = "context string";
    const deps = {
      systemPromptFor: async (t) => {
        if (t === "query") return "Base Prompt";
        return null;
      },
      buildMessages: (sys, q, c) => [{ role: "system", content: sys }, { role: "user", content: q }]
    };

    const messages = await buildStandardMessages(payload, context, deps);
    assert.deepStrictEqual(messages, [
      { role: "system", content: "Base Prompt" },
      { role: "user", content: "Apple" }
    ]);
  });

  test("handles empty base prompt with subtype prompt", async () => {
    const payload = { type: "query", subtype: "recipe", query: "Chicken" };
    const context = "context string";
    const deps = {
      systemPromptFor: async (t) => {
        if (t === "query") return null;
        if (t === "recipe") return "Recipe Prompt";
        return null;
      },
      buildMessages: (sys, q, c) => [{ role: "system", content: sys }, { role: "user", content: q }]
    };

    const messages = await buildStandardMessages(payload, context, deps);
    assert.deepStrictEqual(messages, [
      { role: "system", content: "Recipe Prompt" },
      { role: "user", content: "Chicken" }
    ]);
  });
});

describe("formatRecipeYaml", () => {
  test("bypasses if not recipe", () => {
    const payload = { subtype: "other" };
    const cleanResponse = "raw text";
    const parseYamlBlock = () => { throw new Error("Should not be called") };

    const result = formatRecipeYaml("success", payload, cleanResponse, parseYamlBlock);
    assert.deepStrictEqual(result, { runStatus: "success", finalResponse: "raw text", outcome: null });
  });

  test("converts fake payload too (UI depends on worker for YAML→JSON on every path)", () => {
    const payload = { subtype: "recipe", fake: true };
    const cleanResponse = "```yaml\nkey: value\n```";
    const parseYamlBlock = () => ({ key: "value" });

    const result = formatRecipeYaml("success", payload, cleanResponse, parseYamlBlock);
    assert.deepStrictEqual(result, { runStatus: "success", finalResponse: '{"key":"value"}', outcome: null });
  });

  test("bypasses if runStatus is already fail", () => {
    const payload = { subtype: "recipe" };
    const cleanResponse = "raw text";
    const parseYamlBlock = () => { throw new Error("Should not be called") };

    const result = formatRecipeYaml("fail", payload, cleanResponse, parseYamlBlock, "Previous error");
    assert.deepStrictEqual(result, { runStatus: "fail", finalResponse: "raw text", outcome: "Previous error" });
  });

  test("converts valid YAML to JSON", () => {
    const payload = { subtype: "recipe", jobId: "job123" };
    const cleanResponse = "\`\`\`yaml\nkey: value\n\`\`\`";
    const parseYamlBlock = (text) => ({ key: "value" });

    const result = formatRecipeYaml("success", payload, cleanResponse, parseYamlBlock);
    assert.deepStrictEqual(result, { runStatus: "success", finalResponse: '{"key":"value"}', outcome: null });
  });

  test("falls back to raw text (does not fail) if parsed is null/empty", () => {
    const payload = { subtype: "recipe", jobId: "job123" };
    const cleanResponse = "Empty response";
    const parseYamlBlock = (text) => null;

    const result = formatRecipeYaml("success", payload, cleanResponse, parseYamlBlock);
    // Based on the graceful fallback logic, we do NOT change runStatus to fail, we just leave finalResponse as cleanResponse
    assert.deepStrictEqual(result, { runStatus: "success", finalResponse: "Empty response", outcome: null });
  });

  test("falls back to raw text (does not fail) and logs if YAML parse throws", () => {
    const payload = { subtype: "recipe", jobId: "job123" };
    const cleanResponse = "Malformed yaml: [";
    const parseYamlBlock = (text) => { throw new Error("Parse error"); };

    // We can spy on console.warn, but let's just ensure the return is correct
    const originalWarn = console.warn;
    let warningLogged = false;
    console.warn = (msg) => { warningLogged = true; };

    const result = formatRecipeYaml("success", payload, cleanResponse, parseYamlBlock);
    
    console.warn = originalWarn; // restore
    
    assert.strictEqual(warningLogged, true);
    assert.deepStrictEqual(result, { runStatus: "success", finalResponse: "Malformed yaml: [", outcome: null });
  });
});
