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

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Fake OpenAI-compatible server. `script` maps a request to a reply message.
async function mockLLM(script) {
  const state = { requests: [], active: 0, peak: 0 };
  const server = createServer((req, res) => {
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
  assert.deepEqual(list.result.tools.map((t) => t.name), ["delegate", "delegate_batch", "list_workers"]);
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
