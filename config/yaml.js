import { parse } from "yaml";

/**
 * Robustly extracts and parses a YAML block from LLM output.
 * If the output is fenced (e.g. ```yaml ... ```), it extracts the inner text.
 * Otherwise, it attempts to parse the raw text.
 */
export function extractYamlString(text) {
  if (!text) return "";
  const match = String(text).match(/```(?:[a-z]*)\n?([\s\S]*?)\n?```/i);
  return match ? match[1].trim() : String(text).replace(/```[a-z]*\n?/gi, "").replace(/```/g, "").trim();
}

/**
 * Robustly extracts and parses a YAML block from LLM output.
 * If the output is fenced (e.g. ```yaml ... ```), it extracts the inner text.
 * Otherwise, it attempts to parse the raw text.
 */
export function parseYamlBlock(text) {
  return parse(extractYamlString(text));
}
