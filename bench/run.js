#!/usr/bin/env node
// Runs one arm of a crewlead benchmark in a fresh folder through a headless
// Claude Code session (`claude -p`), using whatever login the CLI has.
//
//   node bench/run.js --arm solo --task popup-book
//   node bench/run.js --arm crew --task popup-book
//
// solo: the lead model writes everything itself.
// crew: the crewlead plugin is loaded, boss mode is on, workers write.
//
// Writes <out>/transcript.jsonl and <out>/result.json. Cost is the figure
// Claude Code reports (total_cost_usd); on a claude.ai login it is the list
// price equivalent, not what the account is billed.

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const arm = args.arm;
const taskName = args.task ?? "popup-book";
const model = args.model ?? "claude-fable-5-2";
const budget = args.budget ?? (arm === "crew" ? "10" : "30");
if (arm !== "solo" && arm !== "crew") {
  console.error("usage: node bench/run.js --arm solo|crew [--task popup-book] [--model id] [--budget usd] [--out dir]");
  process.exit(1);
}

const prompt = readFileSync(join(repo, "bench", taskName, "prompt.md"), "utf8");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = resolve(args.out ?? join(repo, "bench", "out", `${taskName}-${arm}-${stamp}`));
const app = join(out, "app");
mkdirSync(app, { recursive: true });

const PROJECT_FILES = new Set(["crewlead.config.json", ".crewlead", ".git"]);
if (arm === "crew") {
  copyFileSync(join(repo, "bench", "crewlead.bench.json"), join(app, "crewlead.config.json"));
  mkdirSync(join(app, ".crewlead"), { recursive: true });
  writeFileSync(join(app, ".crewlead", "boss"), "benchmark: boss mode on\n");
}

const tools = ["Read", "Glob", "Grep", "Write", "Edit", "Skill",
  "Bash(node:*)", "Bash(ls:*)", "Bash(mkdir:*)", "Bash(wc:*)", "Bash(cat:*)", "Bash(find:*)", "Bash(head:*)", "Bash(grep:*)"];
if (arm === "crew") {
  tools.push(
    "mcp__plugin_crewlead_crewlead__delegate",
    "mcp__plugin_crewlead_crewlead__delegate_batch",
    "mcp__plugin_crewlead_crewlead__list_workers",
  );
}
const cliArgs = ["-p", prompt, "--model", model, "--max-budget-usd", String(budget),
  "--output-format", "stream-json", "--verbose", "--allowedTools", ...tools];
if (arm === "crew") cliArgs.push("--plugin-dir", repo);

console.error(`[bench] ${taskName} ${arm} model=${model} budget=$${budget}\n[bench] folder ${app}`);
const transcript = createWriteStream(join(out, "transcript.jsonl"));
const started = Date.now();
const child = spawn("claude", cliArgs, {
  cwd: app,
  stdio: ["ignore", "pipe", "inherit"],
  env: { ...process.env, MCP_TOOL_TIMEOUT: "3600000" },
});
child.stdout.pipe(transcript);
const code = await new Promise((r) => child.on("close", r));
await new Promise((r) => transcript.end(r));
const wallSeconds = (Date.now() - started) / 1000;

const result = summarize(readFileSync(join(out, "transcript.jsonl"), "utf8"));
Object.assign(result, { task: taskName, arm, model, budgetUsd: Number(budget), exitCode: code, wallSeconds, folder: app, files: countLines(app) });
writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ ...result, delegations: result.delegations.length }, null, 2));

function summarize(jsonl) {
  const events = jsonl.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const uses = new Map();
  const leadWrites = { attempted: 0, succeeded: 0, denied: 0 };
  const delegations = [];
  let final = null;
  for (const e of events) {
    if (e.type === "assistant") {
      for (const c of e.message?.content ?? []) if (c.type === "tool_use") uses.set(c.id, c);
    } else if (e.type === "user") {
      for (const c of e.message?.content ?? []) {
        if (c?.type !== "tool_result") continue;
        const use = uses.get(c.tool_use_id);
        if (!use) continue;
        const text = typeof c.content === "string" ? c.content : (c.content ?? []).map((x) => x.text ?? "").join("");
        if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(use.name)) {
          leadWrites.attempted++;
          if (c.is_error || /hook error|denied|boss mode/i.test(text)) leadWrites.denied++;
          else leadWrites.succeeded++;
        }
        if (/crewlead__delegate/.test(use.name)) {
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { /* not JSON: error text */ }
          const results = parsed?.results ?? (parsed ? [parsed] : []);
          delegations.push({
            tool: use.name.replace(/^.*__/, ""),
            tasks: results.map((r) => ({
              id: r.id, status: r.status, steps: r.steps, seconds: r.seconds,
              verifyPassed: r.verify?.passed ?? null, filesChanged: r.filesChanged, usage: r.usage,
            })),
            error: parsed ? null : text.slice(0, 300),
          });
        }
      }
    } else if (e.type === "result") {
      final = e;
    }
  }
  const tasks = delegations.flatMap((d) => d.tasks);
  const statusCounts = {};
  for (const t of tasks) statusCounts[t.status] = (statusCounts[t.status] ?? 0) + 1;
  return {
    lead: final && {
      costUsd: final.total_cost_usd,
      costBasis: Object.values(final.modelUsage ?? {})[0]?.costBasis ?? null,
      durationSeconds: final.duration_ms / 1000,
      turns: final.num_turns,
      subtype: final.subtype,
      usage: final.modelUsage,
      permissionDenials: final.permission_denials?.length ?? 0,
      finalMessage: final.result,
    },
    leadWrites,
    workers: {
      tasks: tasks.length,
      statuses: statusCounts,
      promptTokens: tasks.reduce((s, t) => s + (t.usage?.promptTokens ?? 0), 0),
      completionTokens: tasks.reduce((s, t) => s + (t.usage?.completionTokens ?? 0), 0),
    },
    delegations,
  };
}

function countLines(dir) {
  const files = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (PROJECT_FILES.has(name)) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push({ path: relative(dir, p), lines: readFileSync(p, "utf8").split("\n").length });
    }
  };
  if (existsSync(dir)) walk(dir);
  return { count: files.length, lines: files.reduce((s, f) => s + f.lines, 0), list: files };
}
