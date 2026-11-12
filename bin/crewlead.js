#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeWorkers, loadConfig } from "../src/config.js";
import { startMcpServer } from "../src/mcp.js";
import { Pool } from "../src/pool.js";
import { checkWorkers, detectServers, keysPresent, suggestConfig, writeConfig } from "../src/setup.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const [cmd = "mcp", ...rest] = process.argv.slice(2);

const HELP = `crewlead ${version}
One lead model plans. Cheap workers build.

Usage:
  crewlead mcp                 Start the MCP server on stdio (default)
  crewlead init [--user] [--force] [--url <base url>]\n                               Find local model servers and write a config
  crewlead workers             Show the configured workers
  crewlead doctor              Send a test request to every worker
  crewlead run "<task>" [--worker name] [--verify "cmd"] [--owns a,b]
  crewlead boss on|off         Block or allow file edits by the lead (Claude Code hook)
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
    // crewlead init [--user] [--force] [--url http://host:port/v1]
    const scope = rest.includes("--user") ? "user" : "project";
    const servers = await detectServers({ urls: flag("url") ? [flag("url")] : [] });
    for (const s of servers) console.log(`found ${s.kind} at ${s.baseUrl}: ${s.models.join(", ") || "no models"}${s.slots ? ` (${s.slots} slots)` : ""}`);
    for (const [k, set] of Object.entries(keysPresent())) console.log(`${k}: ${set ? "set" : "not set"}`);
    let raw = suggestConfig(servers);
    if (!raw) {
      console.log("no local server found and no remote key set: writing the example config, edit it before use");
      raw = JSON.parse(readFileSync(join(root, "crewlead.config.example.json"), "utf8"));
    }
    try {
      console.log(`wrote ${writeConfig(raw, { scope, overwrite: rest.includes("--force") })}`);
    } catch (err) {
      console.error(err.message.replace("Pass overwrite: true", "Use --force"));
      process.exit(1);
    }
    console.log("next: crewlead doctor");
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
    const results = await checkWorkers(config);
    for (const r of results) {
      if (r.error) console.log(`FAIL  ${r.name}  ${r.model} @ ${r.baseUrl}  ${r.error}`);
      else console.log(`ok    ${r.name}  ${r.model} @ ${r.baseUrl}  ${r.ms} ms  tool calling: ${r.toolCalling ? "yes" : "NO (worker cannot edit files)"}`);
    }
    process.exit(results.every((r) => r.ok) ? 0 : 1);
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
    const file = join(process.cwd(), ".crewlead", "boss");
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
