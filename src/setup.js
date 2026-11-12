// Setup helpers shared by `crewlead init`, `crewlead doctor` and the MCP
// `setup` tool: find local OpenAI-compatible servers, suggest a config,
// write it, and check every worker.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, normalize } from "./config.js";
import { chat } from "./llm.js";

// Default ports of the common local servers.
export const LOCAL_CANDIDATES = [
  { kind: "llamacpp", baseUrl: "http://127.0.0.1:8080/v1" },
  { kind: "ollama", baseUrl: "http://127.0.0.1:11434/v1" },
  { kind: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1" },
  { kind: "vllm", baseUrl: "http://127.0.0.1:8000/v1" },
];

// Remote providers crewlead knows how to suggest when their key is set.
export const REMOTE_PRESETS = {
  OPENROUTER_API_KEY: {
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "qwen/qwen3.8-27b",
    maxConcurrency: 8,
    headers: { "HTTP-Referer": "https://github.com/antonellof/crewlead", "X-Title": "crewlead" },
  },
};

async function getJson(url, timeoutMs) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Probe local servers. Returns the ones that answered GET /models.
export async function detectServers({ urls = [], timeoutMs = 1500 } = {}) {
  // URLs the caller names come first, so they win over the default ports.
  const candidates = [
    ...urls.map((u) => ({ kind: "custom", baseUrl: u.replace(/\/+$/, "") })),
    ...LOCAL_CANDIDATES,
  ];
  const found = await Promise.all(candidates.map(async (c) => {
    const models = await getJson(`${c.baseUrl}/models`, timeoutMs);
    if (!Array.isArray(models?.data)) return null;
    // llama.cpp reports its parallel slots on /props, outside /v1.
    const props = await getJson(`${c.baseUrl.replace(/\/v1$/, "")}/props`, timeoutMs);
    return {
      kind: typeof props?.total_slots === "number" && c.kind === "custom" ? "llamacpp" : c.kind,
      baseUrl: c.baseUrl,
      models: models.data.map((m) => m.id).filter(Boolean),
      slots: typeof props?.total_slots === "number" ? props.total_slots : null,
      contextPerSlot: typeof props?.default_generation_settings?.n_ctx === "number" ? props.default_generation_settings.n_ctx : null,
    };
  }));
  const seen = new Set();
  return found.filter((s) => s && !seen.has(s.baseUrl) && seen.add(s.baseUrl));
}

// Which known key variables are set. Never returns the values.
export function keysPresent(env = process.env) {
  return Object.fromEntries(Object.keys(REMOTE_PRESETS).map((k) => [k, Boolean(env[k])]));
}

// Build a config from what detectServers found and which keys are set.
// Returns null when there is nothing to configure.
export function suggestConfig(servers, env = process.env) {
  const providers = {};
  const workers = {};
  let defaultWorker;

  const local = servers.find((s) => s.models.length > 0);
  if (local) {
    const model = local.models[0];
    providers.local = { baseUrl: local.baseUrl, maxConcurrency: local.slots ?? 2 };
    workers.builder = {
      description: `${model} on ${local.kind} at ${local.baseUrl}`,
      provider: "local",
      model,
      ...(local.contextPerSlot ? { contextTokens: local.contextPerSlot } : {}),
      // Qwen 3.x thinks before every answer by default; builders are much
      // faster without it.
      ...(/qwen3/i.test(model) ? { extraBody: { chat_template_kwargs: { enable_thinking: false } } } : {}),
    };
    defaultWorker = "builder";
  }

  for (const [keyEnv, preset] of Object.entries(REMOTE_PRESETS)) {
    if (!env[keyEnv]) continue;
    providers[preset.provider] = {
      baseUrl: preset.baseUrl,
      apiKeyEnv: keyEnv,
      maxConcurrency: preset.maxConcurrency,
      headers: preset.headers,
    };
    const name = local ? "builder-remote" : "builder";
    workers[name] = { description: `${preset.model} on ${preset.provider}`, provider: preset.provider, model: preset.model };
    if (local) workers.builder.fallback = name;
    defaultWorker ??= name;
    break;
  }

  if (!defaultWorker) return null;
  return { providers, workers, defaultWorker };
}

export function configPath(scope, { cwd = process.cwd(), env = process.env } = {}) {
  if (scope === "user") {
    return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "crewlead", "config.json");
  }
  if (scope === "project") return join(cwd, "crewlead.config.json");
  throw new Error(`scope must be "project" or "user", not "${scope}"`);
}

// Validate and write a config. Refuses inline keys and, unless overwrite is
// set, an existing file.
export function writeConfig(raw, { scope = "project", overwrite = false, cwd, env } = {}) {
  if (!raw || typeof raw !== "object") throw new Error("config must be an object");
  for (const [name, p] of Object.entries(raw.providers ?? {})) {
    if (p && "apiKey" in p) {
      throw new Error(`provider "${name}" has an apiKey. Put the key in an environment variable and set "apiKeyEnv" to its name.`);
    }
  }
  normalize(structuredClone(raw), {}); // throws on an invalid config
  const file = configPath(scope, { cwd, env });
  if (existsSync(file) && !overwrite) {
    throw new Error(`${file} already exists. Pass overwrite: true to replace it.`);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
  return file;
}

// Send one tool-calling request to every worker.
export async function checkWorkers(config, env = process.env) {
  return Promise.all(Object.entries(config.workers).map(async ([name, worker]) => {
    const provider = config.providers[worker.provider];
    const started = Date.now();
    try {
      const res = await chat({
        provider,
        worker: { ...worker, maxTokens: 256, requestTimeoutMs: 60_000 },
        messages: [{ role: "user", content: "Call the ping tool." }],
        tools: [{ type: "function", function: { name: "ping", description: "Health check", parameters: { type: "object", properties: {} } } }],
        env,
      });
      const toolCalling = (res.message.tool_calls ?? []).length > 0;
      return { name, model: worker.model, baseUrl: provider.baseUrl, ok: toolCalling, toolCalling, ms: Date.now() - started };
    } catch (err) {
      return { name, model: worker.model, baseUrl: provider.baseUrl, ok: false, toolCalling: null, ms: Date.now() - started, error: err.message };
    }
  }));
}

// The MCP and Pi `setup` tool: detect, write or check.
export async function runSetup({ action, urls = [], config, scope = "project", overwrite = false } = {}, cwd = process.cwd()) {
  if (action === "detect") {
    const servers = await detectServers({ urls });
    const current = loadConfig({ cwd });
    return {
      servers,
      keys: keysPresent(),
      currentConfig: current.source,
      suggestedConfig: suggestConfig(servers),
      ...(servers.length === 0
        ? { hint: "No local server answered. Start one, for example: llama-server -hf unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL --jinja -c 196608 -np 3 --port 8080. Or export OPENROUTER_API_KEY in the shell that starts your agent." }
        : {}),
    };
  }
  if (action === "write") {
    const raw = config ?? suggestConfig(await detectServers({ urls }));
    if (!raw) throw new Error("nothing to write: no local server found and no remote key set. Run detect for details.");
    const file = writeConfig(raw, { scope, overwrite, cwd });
    const loaded = loadConfig({ cwd });
    return {
      wrote: file,
      activeConfig: loaded.source,
      ...(loaded.source !== file ? { note: `${loaded.source} takes precedence over the file just written.` } : {}),
      check: await checkWorkers(loaded),
    };
  }
  if (action === "check") {
    const loaded = loadConfig({ cwd });
    return { configSource: loaded.source, workers: await checkWorkers(loaded) };
  }
  throw new Error(`setup action must be detect, write or check, not "${action}"`);
}
