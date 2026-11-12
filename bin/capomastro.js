#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeWorkers, loadConfig } from "../src/config.js";
import { chat } from "../src/llm.js";
import { startMcpServer } from "../src/mcp.js";
import { Pool } from "../src/pool.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const [cmd = "mcp", ...rest] = process.argv.slice(2);

const HELP = `capomastro ${version}
One lead model plans. Cheap workers build.

Usage:
  capomastro mcp                 Start the MCP server on stdio (default)
  capomastro init                Write capomastro.config.json in this directory
  capomastro workers             Show the configured workers
  capomastro doctor              Send a test request to every worker
  capomastro run "<task>" [--worker name] [--verify "cmd"] [--owns a,b]
  capomastro boss on|off         Block or allow file edits by the lead (Claude Code hook)
`;

function flag(name) {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? undefined : rest[i + 1];
}

switch (cmd) {
  case "mcp":
    startMcpServer({ version });
    break;

  case "init": {
    const target = join(process.cwd(), "capomastro.config.json");
    if (existsSync(target)) {
      console.error(`${target} already exists`);
      process.exit(1);
    }
    writeFileSync(target, readFileSync(join(root, "capomastro.config.example.json")));
    console.log(`wrote ${target}`);
    break;
  }

  case "workers": {
    const config = loadConfig();
    console.log(`config: ${config.source}`);
    console.table(describeWorkers(config).map(({ description, baseUrl, ...w }) => w));
    break;
  }

  case "doctor": {
    const config = loadConfig();
    console.log(`config: ${config.source}`);
    let failed = 0;
    for (const [name, worker] of Object.entries(config.workers)) {
      const provider = config.providers[worker.provider];
      const t = Date.now();
      try {
        const res = await chat({
          provider,
          worker: { ...worker, maxTokens: 256, requestTimeoutMs: 60_000 },
          messages: [{ role: "user", content: "Call the ping tool." }],
          tools: [{ type: "function", function: { name: "ping", description: "Health check", parameters: { type: "object", properties: {} } } }],
        });
        const toolOk = (res.message.tool_calls ?? []).length > 0;
        console.log(`ok    ${name}  ${worker.model} @ ${provider.baseUrl}  ${Date.now() - t} ms  tool calling: ${toolOk ? "yes" : "NO (worker cannot edit files)"}`);
        if (!toolOk) failed++;
      } catch (err) {
        failed++;
        console.log(`FAIL  ${name}  ${worker.model} @ ${provider.baseUrl}  ${err.message}`);
      }
    }
    process.exit(failed ? 1 : 0);
    break;
  }

  case "run": {
    const task = rest.find((a, i) => !a.startsWith("--") && !(rest[i - 1] ?? "").startsWith("--"));
    if (!task) {
      console.error(HELP);
      process.exit(1);
    }
    const pool = new Pool();
    const result = await pool.delegate(
      { id: "cli", task, worker: flag("worker"), verify: flag("verify"), owns: flag("owns")?.split(",") },
      { onEvent: (e) => console.error(`[${e.type}] ${e.name ?? e.worker ?? e.attempt ?? ""}`) },
    );
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === "done" ? 0 : 1);
    break;
  }

  case "boss": {
    const file = join(process.cwd(), ".capomastro", "boss");
    if (rest[0] === "on") {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "The lead model may not edit files. Remove this file to turn boss mode off.\n");
      console.log("boss mode on: the lead can only delegate");
    } else if (rest[0] === "off") {
      rmSync(file, { force: true });
      console.log("boss mode off");
    } else {
      console.log(existsSync(file) ? "on" : "off");
    }
    break;
  }

  default:
    console.log(HELP);
    process.exit(cmd === "help" || cmd === "--help" || cmd === "-h" ? 0 : 1);
}
