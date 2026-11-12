// Runs tasks in parallel with a concurrency cap per provider, and moves a task
// to its fallback worker when the first provider cannot be reached.

import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { ProviderUnreachableError } from "./llm.js";
import { runWorker } from "./worker.js";

class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise((r) => this.queue.push(r));
  }
  release() {
    const next = this.queue.shift();
    if (next) next();
    else this.active--;
  }
}

export class Pool {
  constructor({ config, cwd = process.cwd(), env = process.env } = {}) {
    this.cwd = cwd;
    this.env = env;
    this.config = config ?? loadConfig({ cwd, env });
    this.semaphores = new Map();
  }

  semaphore(providerName) {
    if (!this.semaphores.has(providerName)) {
      this.semaphores.set(providerName, new Semaphore(this.config.providers[providerName].maxConcurrency));
    }
    return this.semaphores.get(providerName);
  }

  async delegate(task, { signal, onEvent } = {}) {
    if (!task?.task) throw new Error("a task needs a 'task' description");
    const cwd = resolve(this.cwd, task.cwd ?? ".");
    let workerName = task.worker ?? this.config.defaultWorker;
    const tried = [];

    while (true) {
      const worker = this.config.workers[workerName];
      if (!worker) {
        throw new Error(`unknown worker "${workerName}". Available: ${Object.keys(this.config.workers).join(", ")}`);
      }
      tried.push(workerName);
      const provider = this.config.providers[worker.provider];
      const sem = this.semaphore(worker.provider);
      await sem.acquire();
      try {
        onEvent?.({ type: "start", id: task.id, worker: workerName });
        const result = await runWorker({ task, worker, provider, cwd, signal, env: this.env, onEvent });
        return { ...result, worker: workerName, provider: worker.provider, ...(tried.length > 1 ? { fellBackFrom: tried.slice(0, -1) } : {}) };
      } catch (err) {
        const next = worker.fallback;
        if (err instanceof ProviderUnreachableError && next && !tried.includes(next)) {
          onEvent?.({ type: "fallback", id: task.id, from: workerName, to: next, reason: err.message });
          workerName = next;
          continue;
        }
        return {
          id: task.id,
          status: "error",
          report: err.message,
          filesChanged: [],
          verify: null,
          worker: workerName,
          provider: worker.provider,
        };
      } finally {
        sem.release();
      }
    }
  }

  async delegateBatch(tasks, opts = {}) {
    if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("delegate_batch needs at least one task");
    const withIds = tasks.map((t, i) => ({ ...t, id: t.id ?? `task-${i + 1}` }));
    const overlaps = findOverlaps(withIds);
    const started = Date.now();
    const results = await Promise.all(withIds.map((t) => this.delegate(t, opts)));
    const cost = results.reduce((s, r) => s + (r.usage?.costUsd ?? 0), 0);
    return {
      results,
      summary: {
        done: results.filter((r) => r.status === "done").length,
        failed: results.filter((r) => r.status !== "done").length,
        seconds: Math.round((Date.now() - started) / 100) / 10,
        workerCostUsd: Math.round(cost * 10000) / 10000,
        ...(overlaps.length ? { warning: `tasks share owned paths: ${overlaps.join("; ")}` } : {}),
      },
    };
  }
}

// Two parallel workers writing the same file will overwrite each other.
function findOverlaps(tasks) {
  const out = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      if ((tasks[i].cwd ?? ".") !== (tasks[j].cwd ?? ".")) continue;
      for (const a of tasks[i].owns ?? []) {
        for (const b of tasks[j].owns ?? []) {
          const x = a.replace(/\/+$/, "");
          const y = b.replace(/\/+$/, "");
          if (x === y || x.startsWith(y + "/") || y.startsWith(x + "/")) {
            out.push(`${tasks[i].id} and ${tasks[j].id} both own ${x.length <= y.length ? x : y}`);
          }
        }
      }
    }
  }
  return out;
}
