import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { normalize } from "../src/config.js";
import { Pool } from "../src/pool.js";
import { compact } from "../src/worker.js";
import { detectServers, suggestConfig, writeConfig } from "../src/setup.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Fake OpenAI-compatible server. `script` maps a request to a reply message.
async function mockLLM(script) {
  const state = { requests: [], active: 0, peak: 0 };
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "mock-qwen3" }] }));
    }
    if (req.method === "GET" && req.url === "/props") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ total_slots: 4, default_generation_settings: { n_ctx: 16384 } }));
    }
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      const parsed = JSON.parse(body);
      state.requests.push({ headers: req.headers, body: parsed });
      state.active++;
      state.peak = Math.max(state.peak, state.active);
      await new Promise((r) => setTimeout(r, 30));
      state.active--;
      const message = script(parsed, state);
      if (message.__status) {
        res.writeHead(message.__status, { "content-type": "application/json" });
        return res.end(JSON.stringify(message.__body));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { state, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => server.close() };
}

let callId = 0;
const call = (name, args) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: `c${++callId}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const say = (content) => ({ role: "assistant", content });
const toolTurns = (body) => body.messages.filter((m) => m.role === "tool").length;
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "crewlead-")));

function config(url, extra = {}) {
  return normalize({
    providers: { local: { baseUrl: url, maxConcurrency: 2 }, ...(extra.providers ?? {}) },
    workers: { builder: { provider: "local", model: "mock", ...(extra.builder ?? {}) }, ...(extra.workers ?? {}) },
  }, {});
}

test("worker writes a file and reports", async () => {
  const llm = await mockLLM((body) =>
    toolTurns(body) === 0 ? call("write_file", { path: "src/a.js", content: "export const a = 1;\n" }) : say("Built a.js."));
  const cwd = tmp();
  const r = await new Pool({ config: config(llm.url), cwd, env: {} }).delegate({ id: "t", task: "make a" });
  llm.close();
  assert.equal(r.status, "done");
  assert.deepEqual(r.filesChanged, ["src/a.js"]);
  assert.equal(readFileSync(join(cwd, "src/a.js"), "utf8"), "export const a = 1;\n");
  assert.equal(r.usage.promptTokens, 200);
  assert.equal(r.usage.costUsd, null);
});

test("writes outside owned paths and outside cwd are rejected", async () => {
  const seen = [];
  const llm = await mockLLM((body) => {
    const n = toolTurns(body);
    if (n > 0) seen.push(body.messages.at(-1).content);
    if (n === 0) return call("write_file", { path: "other/x.js", content: "x" });
    if (n === 1) return call("write_file", { path: "../escape.js", content: "x" });
    if (n === 2) return call("write_file", { path: "mine/x.js", content: "x" });
    return say("done");
  });
  const cwd = tmp();
  const r = await new Pool({ config: config(llm.url), cwd, env: {} }).delegate({ id: "t", task: "x", owns: ["mine"] });
  llm.close();
  assert.match(seen[0], /do not own/);
  assert.match(seen[1], /escapes the working directory/);
  assert.deepEqual(r.filesChanged, ["mine/x.js"]);
  assert.equal(existsSync(join(cwd, "other/x.js")), false);
  assert.equal(existsSync(join(cwd, "..", "escape.js")), false);
});

test("a symlink cannot be used to write outside the project", async () => {
  const outside = tmp();
  const cwd = tmp();
  symlinkSync(outside, join(cwd, "link"));
  let seen = "";
  const llm = await mockLLM((body) => {
    if (toolTurns(body) === 0) return call("write_file", { path: "link/x.js", content: "x" });
    seen = body.messages.at(-1).content;
    return say("done");
  });
  await new Pool({ config: config(llm.url), cwd, env: {} }).delegate({ id: "t", task: "x" });
  llm.close();
  assert.match(seen, /through a symlink/);
  assert.equal(existsSync(join(outside, "x.js")), false);
});

test("verify failure is fed back and the worker retries", async () => {
  const llm = await mockLLM((body) => {
    const n = toolTurns(body);
    const failed = body.messages.some((m) => m.role === "user" && m.content.includes("failed with exit code"));
    if (n === 0) return call("write_file", { path: "out.txt", content: "wrong" });
    if (n === 1 && !failed) return say("done");
    if (n === 1 && failed) return call("write_file", { path: "out.txt", content: "right" });
    return say("fixed");
  });
  const cwd = tmp();
  const r = await new Pool({ config: config(llm.url), cwd, env: {} })
    .delegate({ id: "t", task: "x", verify: "grep -q right out.txt" });
  llm.close();
  assert.equal(r.status, "done");
  assert.equal(r.verify.passed, true);
  assert.equal(r.verify.attempts, 2);
  assert.equal(r.report, "fixed");
});

test("verify that never passes ends as verify_failed", async () => {
  const llm = await mockLLM(() => say("done, trust me"));
  const r = await new Pool({ config: config(llm.url, { builder: { verifyRetries: 1 } }), cwd: tmp(), env: {} })
    .delegate({ id: "t", task: "x", verify: "false" });
  llm.close();
  assert.equal(r.status, "verify_failed");
  assert.equal(r.verify.attempts, 2);
});

test("batch runs in parallel under the provider cap and flags overlap", async () => {
  const llm = await mockLLM(() => say("ok"));
  const pool = new Pool({ config: config(llm.url), cwd: tmp(), env: {} });
  const out = await pool.delegateBatch([
    { task: "a", owns: ["src/a"] }, { task: "b", owns: ["src/b"] },
    { task: "c", owns: ["src"] }, { task: "d" }, { task: "e" },
  ]);
  llm.close();
  assert.equal(out.summary.done, 5);
  assert.equal(llm.state.peak, 2);
  assert.match(out.summary.warning, /task-1 and task-3 both own src/);
  assert.deepEqual(out.results.map((r) => r.id), ["task-1", "task-2", "task-3", "task-4", "task-5"]);
});

test("unreachable local provider falls back to the remote worker with its key", async () => {
  const remote = await mockLLM(() => say("built remotely"));
  const cfg = config("http://127.0.0.1:1/v1", {
    providers: { openrouter: { baseUrl: remote.url, apiKeyEnv: "OR_KEY" } },
    builder: { fallback: "remote" },
    workers: { remote: { provider: "openrouter", model: "qwen/remote", inputPricePerM: 1, outputPricePerM: 10 } },
  });
  const r = await new Pool({ config: cfg, cwd: tmp(), env: { OR_KEY: "sk-test" } }).delegate({ id: "t", task: "x" });
  remote.close();
  assert.equal(r.status, "done");
  assert.equal(r.worker, "remote");
  assert.deepEqual(r.fellBackFrom, ["builder"]);
  assert.equal(remote.state.requests[0].headers.authorization, "Bearer sk-test");
  assert.equal(remote.state.requests[0].body.model, "qwen/remote");
  assert.equal(r.usage.costUsd, 0.0003);
});

test("missing remote key is an error result, not a crash", async () => {
  const cfg = normalize({
    providers: { or: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "NOPE" } },
    workers: { w: { provider: "or", model: "m" } },
  }, {});
  const r = await new Pool({ config: cfg, cwd: tmp(), env: {} }).delegate({ id: "t", task: "x" });
  assert.equal(r.status, "error");
  assert.match(r.report, /set NOPE/);
});

test("config: env-only setup and validation", () => {
  const c = normalize({ providers: {}, workers: {} }, { CREWLEAD_BASE_URL: "http://x/v1/", CREWLEAD_MODEL: "m" });
  assert.equal(c.defaultWorker, "env");
  assert.equal(c.providers.env.baseUrl, "http://x/v1");
  assert.throws(() => normalize({ providers: {}, workers: { w: { provider: "nope", model: "m" } } }, {}), /unknown provider/);
});

test("MCP server: initialize, list tools, call delegate", async () => {
  const llm = await mockLLM((body) =>
    toolTurns(body) === 0 ? call("write_file", { path: "hello.txt", content: "hi" }) : say("wrote hello"));
  const cwd = tmp();
  writeFileSync(join(cwd, "crewlead.config.json"), JSON.stringify({
    providers: { local: { baseUrl: llm.url } }, workers: { builder: { provider: "local", model: "mock" } },
  }));
  const child = spawn("node", [join(root, "bin/crewlead.js"), "mcp"], { cwd, env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "inherit"] });
  const replies = new Map();
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.id !== undefined) replies.get(msg.id)?.(msg);
    }
  });
  const rpc = (id, method, params) => new Promise((resolve) => {
    replies.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

  const init = await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(init.result.serverInfo.name, "crewlead");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const list = await rpc(2, "tools/list", {});
  assert.deepEqual(list.result.tools.map((t) => t.name), ["delegate", "delegate_batch", "list_workers", "setup"]);
  const res = await rpc(3, "tools/call", { name: "delegate", arguments: { task: "write hello" } });
  const payload = JSON.parse(res.result.content[0].text);
  child.kill();
  llm.close();
  assert.equal(payload.status, "done");
  assert.equal(readFileSync(join(cwd, "hello.txt"), "utf8"), "hi");
});

test("boss-mode hook denies only when the flag exists", async () => {
  const cwd = tmp();
  const runHook = () => new Promise((resolve) => {
    const c = spawn("node", [join(root, "hooks/boss-mode.js")], { env: { PATH: process.env.PATH, CLAUDE_PROJECT_DIR: cwd } });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("close", () => resolve(out));
    c.stdin.end(JSON.stringify({ tool_name: "Edit" }));
  });
  assert.equal(await runHook(), "");
  await new Promise((r) => spawn("node", [join(root, "bin/crewlead.js"), "boss", "on"], { cwd }).on("close", r));
  assert.equal(JSON.parse(await runHook()).hookSpecificOutput.permissionDecision, "deny");
});

test("boss-mode hook tells the lead to delegate on UserPromptSubmit", async () => {
  const cwd = tmp();
  const runHook = () => new Promise((resolve) => {
    const c = spawn("node", [join(root, "hooks/boss-mode.js")], { env: { PATH: process.env.PATH, CLAUDE_PROJECT_DIR: cwd } });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("close", () => resolve(out));
    c.stdin.end(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "build it" }));
  });
  assert.equal(await runHook(), "");
  await new Promise((r) => spawn("node", [join(root, "bin/crewlead.js"), "boss", "on"], { cwd }).on("close", r));
  const out = JSON.parse(await runHook()).hookSpecificOutput;
  assert.equal(out.hookEventName, "UserPromptSubmit");
  assert.equal(out.permissionDecision, undefined);
  assert.match(out.additionalContext, /mcp__plugin_crewlead_crewlead__delegate_batch/);
});

test("setup: detect a server, suggest a config with fallback, refuse keys and overwrites", async () => {
  const llm = await mockLLM(() => say("ok"));
  const servers = await detectServers({ urls: [llm.url] });
  llm.close();
  assert.deepEqual(servers[0], { kind: "llamacpp", baseUrl: llm.url, models: ["mock-qwen3"], slots: 4, contextPerSlot: 16384 });

  const localOnly = suggestConfig([servers[0]], {});
  assert.equal(localOnly.defaultWorker, "builder");
  assert.equal(localOnly.providers.local.maxConcurrency, 4);
  assert.equal(localOnly.workers.builder.contextTokens, 16384);
  assert.deepEqual(localOnly.workers.builder.extraBody, { chat_template_kwargs: { enable_thinking: false } });
  assert.equal(localOnly.providers.openrouter, undefined);

  const withRemote = suggestConfig([servers[0]], { OPENROUTER_API_KEY: "x" });
  assert.equal(withRemote.workers.builder.fallback, "builder-remote");
  assert.equal(withRemote.providers.openrouter.apiKeyEnv, "OPENROUTER_API_KEY");
  assert.ok(!JSON.stringify(withRemote).includes('"x"'), "the key value never ends up in the config");

  const remoteOnly = suggestConfig([], { OPENROUTER_API_KEY: "x" });
  assert.equal(remoteOnly.workers.builder.provider, "openrouter");
  assert.equal(suggestConfig([], {}), null);

  const cwd = tmp();
  assert.throws(() => writeConfig({ ...localOnly, providers: { local: { ...localOnly.providers.local, apiKey: "sk" } } }, { cwd }), /apiKey/);
  const file = writeConfig(localOnly, { cwd });
  assert.equal(file, join(cwd, "crewlead.config.json"));
  assert.throws(() => writeConfig(localOnly, { cwd }), /already exists/);
  writeConfig(localOnly, { cwd, overwrite: true });
  const userFile = writeConfig(localOnly, { scope: "user", env: { XDG_CONFIG_HOME: join(cwd, "xdg") } });
  assert.equal(userFile, join(cwd, "xdg", "crewlead", "config.json"));
});

test("MCP setup tool: detect, write, then the pool uses the new config", async () => {
  const llm = await mockLLM((body) => (body.tools?.some((t) => t.function.name === "ping") ? call("ping", {}) : say("ok")));
  const cwd = tmp();
  const child = spawn("node", [join(root, "bin/crewlead.js"), "mcp"], { cwd, env: { PATH: process.env.PATH, HOME: cwd }, stdio: ["pipe", "pipe", "inherit"] });
  const replies = new Map();
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.id !== undefined) replies.get(msg.id)?.(msg);
    }
  });
  const rpc = (id, name, args) => new Promise((resolve) => {
    replies.set(id, (m) => resolve(JSON.parse(m.result.content[0].text)));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
  });

  const before = await rpc(1, "list_workers", {});
  assert.equal(before.configSource, "defaults");
  assert.match(before.hint, /setup/);

  const detected = await rpc(2, "setup", { action: "detect", urls: [llm.url] });
  assert.equal(detected.servers[0].baseUrl, llm.url);
  assert.equal(detected.keys.OPENROUTER_API_KEY, false);
  assert.equal(detected.suggestedConfig.providers.local.baseUrl, llm.url);

  const wrote = await rpc(3, "setup", { action: "write", config: detected.suggestedConfig });
  assert.equal(wrote.wrote, join(cwd, "crewlead.config.json"));
  assert.equal(wrote.activeConfig, wrote.wrote);
  assert.equal(wrote.check[0].ok, true);

  const after = await rpc(4, "list_workers", {});
  assert.equal(after.configSource, join(cwd, "crewlead.config.json"));
  assert.equal(after.workers[0].model, "mock-qwen3");
  child.kill();
  llm.close();
});

const OVERFLOW = {
  __status: 400,
  __body: { error: { code: 400, message: "request (68069 tokens) exceeds the available context size (65536 tokens), try increasing it", type: "exceed_context_size_error" } },
};
const big = (c) => c.repeat(2000);
const dropped = (body) => JSON.stringify(body.messages).includes("dropped to save context");

test("context overflow: the worker drops old output, retries and finishes", async () => {
  let overflowed = false;
  const llm = await mockLLM((body) => {
    const n = toolTurns(body);
    if (n === 0) return call("write_file", { path: "a.js", content: big("a") });
    if (n === 1) return call("run", { command: `node -e "console.log('x'.repeat(3000))"` });
    if (n === 2) return call("write_file", { path: "b.js", content: big("b") });
    if (n === 3) return call("list_dir", {});
    if (!overflowed) {
      overflowed = true;
      return OVERFLOW;
    }
    return say(dropped(body) ? "done after compacting" : "never compacted");
  });
  const cwd = tmp();
  const events = [];
  const r = await new Pool({ config: config(llm.url), cwd, env: {} }).delegate(
    { id: "t", task: "x" },
    { onEvent: (e) => events.push(e.type) },
  );
  llm.close();
  assert.equal(r.status, "done");
  assert.equal(r.report, "done after compacting");
  assert.ok(events.includes("compact"));
  assert.equal(r.steps, 5, "the overflowed request is not charged as a step");
  assert.equal(readFileSync(join(cwd, "a.js"), "utf8").length, 2000, "files on disk are untouched");
});

test("context overflow that compaction cannot fix is an error with a clear message", async () => {
  const llm = await mockLLM(() => OVERFLOW);
  const r = await new Pool({ config: config(llm.url), cwd: tmp(), env: {} }).delegate({ id: "t", task: "x" });
  llm.close();
  assert.equal(r.status, "error");
  assert.match(r.report, /does not fit the model's context/);
});

test("contextTokens: the history shrinks before the server overflows", async () => {
  const seen = [];
  const llm = await mockLLM((body) => {
    seen.push(dropped(body));
    const n = toolTurns(body);
    if (n < 8) return call("write_file", { path: `f${n}.js`, content: big("x") });
    return say("done");
  });
  // The mock reports 100 prompt tokens per request: above 70% of 120.
  const events = [];
  const r = await new Pool({ config: config(llm.url, { builder: { contextTokens: 120 } }), cwd: tmp(), env: {} }).delegate(
    { id: "t", task: "x" },
    { onEvent: (e) => events.push(e.type) },
  );
  llm.close();
  assert.equal(r.status, "done");
  assert.ok(events.includes("compact"));
  assert.equal(seen[0], false);
  assert.equal(seen.at(-1), true);
});

test("compact keeps the system prompt, the task and recent messages", () => {
  const long = "y".repeat(1000);
  const messages = [
    { role: "system", content: long },
    { role: "user", content: long },
    { role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "a.js", content: long }) } }] },
    { role: "tool", tool_call_id: "1", content: long },
    { role: "assistant", content: "", tool_calls: [{ id: "2", type: "function", function: { name: "run", arguments: "{not json" + long } }] },
    { role: "tool", tool_call_id: "2", content: long },
  ];
  assert.equal(compact(messages, 1), true);
  assert.equal(messages[0].content, long);
  assert.equal(messages[1].content, long);
  assert.deepEqual(JSON.parse(messages[2].tool_calls[0].function.arguments).path, "a.js");
  assert.match(JSON.parse(messages[2].tool_calls[0].function.arguments).content, /dropped to save context: 1000/);
  assert.match(messages[3].content, /dropped to save context/);
  assert.doesNotThrow(() => JSON.parse(messages[4].tool_calls[0].function.arguments), "arguments stay valid JSON");
  assert.equal(messages[5].content, long, "the most recent message is kept");
  assert.equal(compact(messages, 1), false, "a second pass has nothing left to drop");
});

test("max_steps: warns before the limit and reports what the worker was doing", async () => {
  let warned = false;
  const llm = await mockLLM((body) => {
    if (JSON.stringify(body.messages).includes("You have 3 turns left")) warned = true;
    return call("run", { command: "echo still looking" });
  });
  const r = await new Pool({ config: config(llm.url, { builder: { maxSteps: 5 } }), cwd: tmp(), env: {} }).delegate({ id: "t", task: "x" });
  llm.close();
  assert.equal(r.status, "max_steps");
  assert.ok(warned);
  assert.deepEqual(r.toolCalls, { run: 5 });
  assert.match(r.report, /Stopped after 5 steps without finishing/);
  assert.match(r.report, /Tool calls: run x5/);
  assert.match(r.report, /Files written: none/);
  assert.match(r.report, /Last call: run .*echo still looking.* -> exit code 0 still looking/);
});

test("read_file counts lines without the trailing newline", async () => {
  const cwd = tmp();
  writeFileSync(join(cwd, "three.txt"), "a\nb\nc\n");
  writeFileSync(join(cwd, "long.txt"), Array.from({ length: 5 }, (_, i) => `l${i + 1}`).join("\n") + "\n");
  const outputs = [];
  const llm = await mockLLM((body) => {
    const n = toolTurns(body);
    if (n > 0) outputs.push(body.messages.at(-1).content);
    if (n === 0) return call("read_file", { path: "three.txt" });
    if (n === 1) return call("read_file", { path: "long.txt", limit: 2 });
    return say("done");
  });
  await new Pool({ config: config(llm.url), cwd, env: {} }).delegate({ id: "t", task: "x" });
  llm.close();
  assert.equal(outputs[0], "1\ta\n2\tb\n3\tc");
  assert.match(outputs[1], /\[5 lines total/);
});

test("every example config is valid and keeps keys out of the file", async () => {
  const { readdirSync } = await import("node:fs");
  const dir = join(root, "examples", "configs");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 5);
  for (const f of files) {
    const raw = JSON.parse(readFileSync(join(dir, f), "utf8"));
    assert.doesNotThrow(() => normalize(structuredClone(raw), {}), f);
    for (const p of Object.values(raw.providers)) assert.equal(p.apiKey, undefined, `${f} has an inline key`);
  }
  for (const f of ["crewlead.config.example.json", "bench/crewlead.bench.json"]) {
    assert.doesNotThrow(() => normalize(JSON.parse(readFileSync(join(root, f), "utf8")), {}), f);
  }
});

test("run cap: nudges halfway and on repeats, then refuses run until a file changes", async () => {
  const outputs = [];
  const llm = await mockLLM((body) => {
    const last = body.messages.at(-1);
    if (last.role === "tool") outputs.push(last.content);
    if (last.role === "tool" && last.content.startsWith("refused")) return say("done, the file was already written");
    return call("run", { command: "echo checking" });
  });
  const r = await new Pool({ config: config(llm.url, { builder: { maxRunsWithoutChange: 4, maxSteps: 20 } }), cwd: tmp(), env: {} }).delegate({ id: "t", task: "x" });
  llm.close();
  assert.equal(r.status, "done");
  assert.equal(r.toolCalls.run, 5);
  assert.equal(r.toolCalls.run_refused, 1);
  assert.doesNotMatch(outputs[0], /crewlead:/);
  assert.match(outputs[1], /ran 2 commands since your last file change/);
  assert.match(outputs[2], /exact command 3 times in a row/);
  assert.match(outputs[4], /^refused: you ran 4 commands/);
});

test("run cap: a file change resets the count, and 0 turns the cap off", async () => {
  const script = (body) => {
    const n = toolTurns(body);
    if (n === 3) return call("write_file", { path: "a.js", content: "x" });
    if (n < 7) return call("run", { command: `echo ${n}` });
    return say("done");
  };
  for (const cap of [3, 0]) {
    const outputs = [];
    const llm = await mockLLM((body) => {
      if (body.messages.at(-1).role === "tool") outputs.push(body.messages.at(-1).content);
      return script(body);
    });
    const r = await new Pool({ config: config(llm.url, { builder: { maxRunsWithoutChange: cap } }), cwd: tmp(), env: {} }).delegate({ id: "t", task: "x" });
    llm.close();
    assert.equal(r.status, "done");
    assert.equal(r.toolCalls.run_refused, undefined, `cap ${cap}: nothing refused`);
    if (cap === 0) assert.ok(outputs.every((o) => !o.includes("crewlead:")));
  }
});

test("setup: recognises an mlx-vlm server and skips its unloaded drafter", async () => {
  const { createServer: mk } = await import("node:http");
  const server = mk((req, res) => {
    res.writeHead(req.url.endsWith("/models") ? 200 : 404, { "content-type": "application/json" });
    res.end(req.url.endsWith("/models")
      ? JSON.stringify({ data: [
        { id: "someone/Model-27B-MTP-MLX-8bit", loaded: false },
        { id: "someone/Qwen3.8-27B-MLX-8bit", loaded: true },
      ] })
      : "{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  const [found] = await detectServers({ urls: [url] });
  server.close();
  assert.equal(found.kind, "mlx");
  assert.deepEqual(found.models, ["someone/Qwen3.8-27B-MLX-8bit"]);
  const cfg = suggestConfig([found], {});
  assert.equal(cfg.workers.builder.model, "someone/Qwen3.8-27B-MLX-8bit");
  assert.deepEqual(cfg.workers.builder.extraBody, { chat_template_kwargs: { enable_thinking: false } });
});

test("a request that uses up requestTimeoutMs fails once, without retries", async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: say("late") }] }));
    }, 1500);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  const r = await new Pool({ config: config(url, { builder: { requestTimeoutMs: 300 } }), cwd: tmp(), env: {} }).delegate({ id: "t", task: "x" });
  server.closeAllConnections();
  server.close();
  assert.equal(r.status, "error");
  assert.match(r.report, /did not answer within 0 s|did not answer within/);
  assert.equal(requests, 1);
});

test("a slow but successful response is not cut off by the HTTP client", async () => {
  const llm = await mockLLM(() => say("done"));
  const slow = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: say("finished after a long wait") }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    }, 1200));
  });
  await new Promise((r) => slow.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${slow.address().port}/v1`;
  const r = await new Pool({ config: config(url, { builder: { requestTimeoutMs: 5000 } }), cwd: tmp(), env: {} }).delegate({ id: "t", task: "x" });
  slow.close();
  llm.close();
  assert.equal(r.status, "done");
  assert.equal(r.report, "finished after a long wait");
});

test("run cap: after three refusals in a row the run tool is removed", async () => {
  const toolLists = [];
  const llm = await mockLLM((body) => {
    const names = (body.tools ?? []).map((t) => t.function.name);
    toolLists.push(names);
    if (!names.includes("run")) return say("reported without run");
    return call("run", { command: "echo again" });
  });
  const r = await new Pool({ config: config(llm.url, { builder: { maxRunsWithoutChange: 2, maxSteps: 20 } }), cwd: tmp(), env: {} }).delegate({ id: "t", task: "x" });
  llm.close();
  assert.equal(r.status, "done");
  assert.equal(r.report, "reported without run");
  assert.equal(r.toolCalls.run, 5);
  assert.equal(r.toolCalls.run_refused, 3);
  assert.ok(toolLists.at(-1).includes("write_file"), "the file tools stay");
  assert.ok(!toolLists.at(-1).includes("run"));
});
