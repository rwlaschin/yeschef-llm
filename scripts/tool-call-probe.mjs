// Standalone probe: reproduce the worker's EXACT /api/chat tool-calling request and
// dissect the stream. Does the model put its web_search call in the structured
// `tool_calls` field (worker captures it) or write it as TEXT content (leaks to stream)?
//
// Run: node scripts/tool-call-probe.mjs [model]
import { DEFAULT_TOOLS } from "../config/models.js";

const HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const MODEL = process.argv[2] || process.env.OLLAMA_MODEL || "llama3.1:8b";

// Built EXACTLY like worker/index.js (TOOLS).
const TOOLS = DEFAULT_TOOLS.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

// Verbatim copy of worker/index.js parseTextToolCall (the text-tool-call recovery).
function parseTextToolCall(content, toolDefs) {
  if (!content || !content.includes('"name"')) return null;
  const names = new Set(toolDefs.map((t) => t.function.name));
  for (let i = content.indexOf("{"); i >= 0; i = content.indexOf("{", i + 1)) {
    let depth = 0, inStr = false;
    for (let j = i; j < content.length; j++) {
      const ch = content[j];
      if (inStr) { if (ch === "\\") j++; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          const obj = JSON.parse(content.slice(i, j + 1));
          if (obj && names.has(obj.name)) return { function: { name: obj.name, arguments: obj.parameters || obj.arguments || {} } };
        } catch { /* keep scanning */ }
        break;
      }
    }
  }
  return null;
}

async function probe({ withTools }) {
  const messages = [
    { role: "system", content: "You are a research assistant. When you need current facts you do not know, use the web_search tool. Do not answer from memory for current events." },
    { role: "user", content: "Search the web for the latest 2026 CMS institutional patient feeding requirements and tell me what changed." },
  ];
  const body = {
    model: MODEL,
    messages,
    stream: true,
    options: { temperature: 0.8, num_ctx: 8192, num_predict: -1 },
  };
  if (withTools) body.tools = TOOLS;

  const res = await fetch(`${HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`chat failed: ${res.status} ${res.statusText}`);

  // EXACT worker NDJSON parse (chatRound).
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let content = "", toolCalls = [], buf = "";
  const consume = (line) => {
    if (!line.trim()) return;
    let chunk; try { chunk = JSON.parse(line); } catch { return; }
    if (chunk.message?.content) content += chunk.message.content;
    if (chunk.message?.tool_calls?.length) toolCalls = toolCalls.concat(chunk.message.tool_calls);
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) consume(line);
  }
  buf += decoder.decode();
  consume(buf);

  const recovered = toolCalls.length ? null : parseTextToolCall(content, TOOLS);
  return { content, toolCalls, recovered };
}

function report(label, r) {
  console.log(`\n========== ${label} ==========`);
  console.log(`structured tool_calls captured : ${r.toolCalls.length}`);
  if (r.toolCalls.length) console.log(`  -> ${JSON.stringify(r.toolCalls)}`);
  console.log(`text-recovered tool call       : ${r.recovered ? JSON.stringify(r.recovered) : "none"}`);
  console.log(`visible content (${r.content.length} chars):`);
  console.log(r.content.slice(0, 1200) + (r.content.length > 1200 ? " …[clipped]" : ""));
  // Verdict
  if (r.toolCalls.length) console.log(`VERDICT: ✅ model used the STRUCTURED tool_calls field — worker WOULD execute it.`);
  else if (r.recovered) console.log(`VERDICT: ⚠️  model wrote the call as TEXT, but parseTextToolCall RECOVERS it — worker would execute it (only on the chatWithTools path).`);
  else if (/"name"\s*:\s*"web_(search|fetch)"|web_search|web_fetch/i.test(r.content)) console.log(`VERDICT: ❌ model emitted a tool-call-ish JSON as TEXT that was NOT recovered — this LEAKS into the stream.`);
  else console.log(`VERDICT: model just answered from memory (no tool call).`);
}

console.log(`Model: ${MODEL} @ ${HOST}`);
console.log(`TOOLS sent: ${TOOLS.map((t) => t.function.name).join(", ")}`);

// 1) WITH tools (the chatWithTools path) — does it emit structured tool_calls?
report("WITH tools (chatWithTools path)", await probe({ withTools: true }));
// 2) WITHOUT tools (the chatNoTools path the worker falls into when payload.tools is empty)
report("WITHOUT tools (chatNoTools path)", await probe({ withTools: false }));
