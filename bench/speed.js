#!/usr/bin/env node
// Measures an OpenAI-compatible server the way crewlead uses it.
//
//   node bench/speed.js --url http://127.0.0.1:8080/v1 [--model id] [--parallel 1,3] [--tokens 400] [--runs 2]
//
// For each parallel level it sends that many identical long-answer requests
// at once and reports generated tokens per second per stream and combined
// (end to end, prefill included). Then it sends 10 tool-calling requests and
// counts how many come back as a valid tool call. Thinking is turned off with
// chat_template_kwargs, as crewlead's suggested configs do.

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const url = (args.url ?? "http://127.0.0.1:8080/v1").replace(/\/+$/, "");
const levels = (args.parallel ?? "1,3").split(",").map(Number);
const maxTokens = Number(args.tokens ?? 400);
const runs = Number(args.runs ?? 2);
const extra = { chat_template_kwargs: { enable_thinking: false } };

const models = await (await fetch(`${url}/models`)).json();
const model = args.model ?? models.data?.[0]?.id;

async function chat(body) {
  const started = performance.now();
  const res = await fetch(`${url}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, temperature: 0.2, ...extra, ...body }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return { data, seconds: (performance.now() - started) / 1000 };
}

const prompt = "Write a detailed technical explanation, at least 600 words, of how a hash map handles collisions, " +
  "with a JavaScript example of separate chaining. Do not stop early.";

const speed = [];
for (const n of levels) {
  for (let r = 0; r < runs; r++) {
    const started = performance.now();
    const results = await Promise.all(
      Array.from({ length: n }, () => chat({ max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] })),
    );
    const wall = (performance.now() - started) / 1000;
    const tokens = results.reduce((s, x) => s + (x.data.usage?.completion_tokens ?? 0), 0);
    const perStream = results.map((x) => (x.data.usage?.completion_tokens ?? 0) / x.seconds);
    speed.push({
      parallel: n,
      run: r + 1,
      tokens,
      wallSeconds: round(wall),
      combinedTokPerSec: round(tokens / wall),
      perStreamTokPerSec: round(perStream.reduce((a, b) => a + b, 0) / n),
    });
    console.error(`parallel ${n} run ${r + 1}: ${round(tokens / wall)} tok/s combined, ${round(perStream.reduce((a, b) => a + b, 0) / n)} per stream`);
  }
}

const tools = [{
  type: "function",
  function: {
    name: "write_file",
    description: "Create or overwrite a file with the full content.",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  },
}];
let valid = 0;
const toolSeconds = [];
for (let i = 0; i < 10; i++) {
  const { data, seconds } = await chat({
    max_tokens: 1024,
    tools,
    tool_choice: "auto",
    messages: [{ role: "user", content: `Create src/add${i}.js exporting a function add${i}(a, b) that returns a + b + ${i}. Use the write_file tool.` }],
  });
  toolSeconds.push(seconds);
  const call = data.choices?.[0]?.message?.tool_calls?.[0];
  try {
    const a = JSON.parse(call.function.arguments);
    if (call.function.name === "write_file" && a.path?.includes(`add${i}`) && a.content?.includes(`add${i}`)) valid++;
  } catch { /* not a valid call */ }
}

const out = {
  url,
  model,
  maxTokens,
  speed,
  toolCalls: { valid, of: 10, avgSeconds: round(toolSeconds.reduce((a, b) => a + b, 0) / toolSeconds.length) },
};
console.log(JSON.stringify(out, null, 2));

function round(n) {
  return Math.round(n * 10) / 10;
}
