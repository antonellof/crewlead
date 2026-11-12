// Dependency-free MCP server over stdio (newline-delimited JSON-RPC 2.0).

import { createInterface } from "node:readline";
import { describeWorkers } from "./config.js";
import { Pool } from "./pool.js";
import { GUIDELINES, TOOLS } from "./schema.js";

const PROTOCOL_VERSION = "2025-06-18";

export function startMcpServer({ version = "0.0.0", input = process.stdin, output = process.stdout } = {}) {
  // Claude Code and Codex start the server in the project directory.
  const cwd = process.env.CREWLEAD_CWD || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let pool = null;
  const getPool = () => (pool ??= new Pool({ cwd }));
  const running = new Map();

  const send = (msg) => output.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  const text = (value, isError = false) => ({
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  });

  async function callTool(name, args, signal, progress) {
    if (name === "list_workers") {
      const p = getPool();
      return text({ configSource: p.config.source, workers: describeWorkers(p.config) });
    }
    if (name === "delegate") {
      const r = await getPool().delegate({ id: "task-1", ...args }, { signal, onEvent: progress });
      return text(r, r.status !== "done");
    }
    if (name === "delegate_batch") {
      const r = await getPool().delegateBatch(args.tasks, { signal, onEvent: progress });
      return text(r);
    }
    throw new Error(`unknown tool: ${name}`);
  }

  async function handle(msg) {
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;
    try {
      switch (method) {
        case "initialize":
          return send({
            id,
            result: {
              protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: "crewlead", version },
              instructions: GUIDELINES,
            },
          });
        case "ping":
          return send({ id, result: {} });
        case "tools/list":
          return send({ id, result: { tools: TOOLS } });
        case "tools/call": {
          const controller = new AbortController();
          running.set(id, controller);
          const token = params?._meta?.progressToken;
          let n = 0;
          const progress = token === undefined ? undefined : (ev) => {
            send({
              method: "notifications/progress",
              params: { progressToken: token, progress: ++n, message: `${ev.id ?? ""} ${ev.type} ${ev.name ?? ev.worker ?? ""}`.trim() },
            });
          };
          try {
            const result = await callTool(params?.name, params?.arguments ?? {}, controller.signal, progress);
            send({ id, result });
          } catch (err) {
            send({ id, result: text(`crewlead error: ${err.message}`, true) });
          } finally {
            running.delete(id);
          }
          return;
        }
        case "notifications/cancelled":
          running.get(params?.requestId)?.abort();
          return;
        default:
          if (isRequest) send({ id, error: { code: -32601, message: `method not found: ${method}` } });
      }
    } catch (err) {
      if (isRequest) send({ id, error: { code: -32603, message: err.message } });
    }
  }

  const rl = createInterface({ input });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ id: null, error: { code: -32700, message: "parse error" } });
    }
    handle(msg);
  });
  rl.on("close", () => {
    for (const c of running.values()) c.abort();
  });
  return rl;
}
