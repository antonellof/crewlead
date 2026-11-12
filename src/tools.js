// Tools a worker can call. File tools are confined to the task's working
// directory, and writes are confined to the paths the task owns.

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const MAX_OUTPUT = 12_000;

export const TOOL_SCHEMAS = [
  fn("read_file", "Read a text file. Returns numbered lines.", {
    path: { type: "string", description: "Path relative to the working directory" },
    offset: { type: "integer", description: "First line to read, 1-based" },
    limit: { type: "integer", description: "Max lines to read (default 400)" },
  }, ["path"]),
  fn("write_file", "Create or overwrite a file with the full content.", {
    path: { type: "string" },
    content: { type: "string" },
  }, ["path", "content"]),
  fn("edit_file", "Replace one exact occurrence of old_string with new_string in a file.", {
    path: { type: "string" },
    old_string: { type: "string", description: "Exact text to replace. Must match once." },
    new_string: { type: "string" },
  }, ["path", "old_string", "new_string"]),
  fn("list_dir", "List files in a directory.", {
    path: { type: "string", description: "Directory path, default '.'" },
  }, []),
  fn("run", "Run a shell command in the working directory. Use for tests, builds, grep.", {
    command: { type: "string" },
  }, ["command"]),
];

function fn(name, description, properties, required) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

export function createToolbox({ cwd, owns = [], allowShell = true, commandTimeoutMs = 120_000, signal }) {
  const root = realpathSync(resolve(cwd));
  const changed = new Set();
  const ownedRoots = owns.map((p) => resolve(root, p));

  function inside(path) {
    const abs = isAbsolute(path) ? resolve(path) : resolve(root, path);
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new Error(`path escapes the working directory: ${path}`);
    }
    // A symlink inside the project must not lead outside of it.
    const real = realOfNearestExisting(abs);
    if (real !== root && !real.startsWith(root + sep)) {
      throw new Error(`path escapes the working directory through a symlink: ${path}`);
    }
    return abs;
  }

  function writable(path) {
    const abs = inside(path);
    if (ownedRoots.length === 0) return abs;
    const ok = ownedRoots.some((o) => abs === o || abs.startsWith(o + sep));
    if (!ok) {
      throw new Error(
        `you do not own ${relative(root, abs)}. You may only write to: ${owns.join(", ")}. ` +
        `If the task needs a change there, say so in your final report.`,
      );
    }
    return abs;
  }

  const impl = {
    async read_file({ path, offset = 1, limit = 400 }) {
      const text = await readFile(inside(path), "utf8");
      const lines = text.split("\n");
      const start = Math.max(1, offset);
      const slice = lines.slice(start - 1, start - 1 + limit);
      const body = slice.map((l, i) => `${start + i}\t${l}`).join("\n");
      const more = start - 1 + limit < lines.length ? `\n[${lines.length} lines total, use offset to read more]` : "";
      return body + more;
    },
    async write_file({ path, content }) {
      const abs = writable(path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
      changed.add(relative(root, abs));
      return `wrote ${relative(root, abs)} (${content.split("\n").length} lines)`;
    },
    async edit_file({ path, old_string, new_string }) {
      const abs = writable(path);
      const text = await readFile(abs, "utf8");
      const count = text.split(old_string).length - 1;
      if (count === 0) throw new Error("old_string not found. Read the file again and copy the exact text.");
      if (count > 1) throw new Error(`old_string matches ${count} times. Add surrounding lines to make it unique.`);
      await writeFile(abs, text.replace(old_string, () => new_string));
      changed.add(relative(root, abs));
      return `edited ${relative(root, abs)}`;
    },
    async list_dir({ path = "." }) {
      const abs = inside(path);
      const entries = await readdir(abs, { withFileTypes: true });
      const names = entries
        .filter((e) => e.name !== ".git" && e.name !== "node_modules")
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      return names.join("\n") || "(empty)";
    },
    async run({ command }) {
      if (!allowShell) throw new Error("shell access is disabled for this task");
      const r = await runCommand(command, { cwd: root, timeoutMs: commandTimeoutMs, signal });
      return `exit code ${r.code}${r.timedOut ? " (timed out)" : ""}\n${r.output}`;
    },
  };

  return {
    changed,
    async call(name, rawArgs) {
      const tool = impl[name];
      if (!tool) return `error: unknown tool ${name}`;
      let args;
      try {
        args = typeof rawArgs === "string" ? JSON.parse(rawArgs || "{}") : rawArgs ?? {};
      } catch {
        return "error: tool arguments were not valid JSON. Send the call again with valid JSON.";
      }
      try {
        return clip(await tool(args));
      } catch (err) {
        return `error: ${err.message}`;
      }
    },
  };
}

function realOfNearestExisting(abs) {
  let current = abs;
  while (true) {
    try {
      return realpathSync(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

export function runCommand(command, { cwd, timeoutMs = 120_000, signal } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn("bash", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let output = "";
    let timedOut = false;
    const kill = () => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    const collect = (d) => { if (output.length < MAX_OUTPUT * 4) output += d; };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ code: 127, output: String(err.message), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, output: clip(output.trim()), timedOut });
    });
  });
}

// Keep the head and the tail: errors usually sit at the end.
export function clip(text, max = MAX_OUTPUT) {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.4));
  const tail = text.slice(-Math.floor(max * 0.6));
  return `${head}\n[... ${text.length - max} characters cut ...]\n${tail}`;
}

export async function pathExists(path) {
  try { await stat(path); return true; } catch { return false; }
}
