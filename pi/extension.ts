// Pi extension: the same worker pool, called in-process. No MCP needed.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describeWorkers } from "../src/config.js";
import { Pool } from "../src/pool.js";
import { GUIDELINES, TOOLS } from "../src/schema.js";

export default function (pi: ExtensionAPI) {
  const pools = new Map<string, Pool>();
  const poolFor = (cwd: string) => {
    if (!pools.has(cwd)) pools.set(cwd, new Pool({ cwd }));
    return pools.get(cwd)!;
  };
  const schema = (name: string) => TOOLS.find((t) => t.name === name)!;
  const text = (value: unknown) => ({
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    details: undefined,
  });
  const progress = (onUpdate: any) => (ev: any) =>
    onUpdate?.({
      content: [{ type: "text", text: `${ev.id ?? ""} ${ev.type} ${ev.name ?? ev.worker ?? ""}`.trim() }],
      details: undefined,
    });

  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description: schema("delegate").description,
    promptSnippet: "Hand one coding task to a cheaper worker model",
    promptGuidelines: GUIDELINES.split("\n").slice(1).map((l) => l.replace(/^\d+\.\s*/, "capomastro: ")),
    parameters: schema("delegate").inputSchema as any,
    async execute(_id, params: any, signal, onUpdate, ctx) {
      return text(await poolFor(ctx.cwd).delegate({ id: "task-1", ...params }, { signal, onEvent: progress(onUpdate) }));
    },
  });

  pi.registerTool({
    name: "delegate_batch",
    label: "Delegate batch",
    description: schema("delegate_batch").description,
    promptSnippet: "Run several worker tasks in parallel on disjoint files",
    parameters: schema("delegate_batch").inputSchema as any,
    async execute(_id, params: any, signal, onUpdate, ctx) {
      return text(await poolFor(ctx.cwd).delegateBatch(params.tasks, { signal, onEvent: progress(onUpdate) }));
    },
  });

  pi.registerTool({
    name: "list_workers",
    label: "List workers",
    description: schema("list_workers").description,
    parameters: schema("list_workers").inputSchema as any,
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const pool = poolFor(ctx.cwd);
      return text({ configSource: pool.config.source, workers: describeWorkers(pool.config) });
    },
  });

  pi.registerCommand("workers", {
    description: "Show capomastro worker profiles",
    handler: async (_args, ctx) => {
      const pool = poolFor(ctx.cwd);
      const lines = describeWorkers(pool.config).map(
        (w) => `${w.default ? "*" : " "} ${w.name}: ${w.model} via ${w.provider} (x${w.maxConcurrency})`,
      );
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
