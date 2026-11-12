// Config loading. A config names providers (OpenAI-compatible endpoints, local
// or remote) and worker profiles (provider + model + limits).

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DEFAULT_CONFIG = {
  providers: {
    local: {
      baseUrl: "http://127.0.0.1:11434/v1",
      maxConcurrency: 3,
    },
  },
  workers: {
    builder: {
      provider: "local",
      model: "qwen3.8:27b",
    },
  },
  defaultWorker: "builder",
};

const WORKER_DEFAULTS = {
  temperature: 0.2,
  maxSteps: 40,
  maxTokens: 8192,
  verifyRetries: 3,
  maxRunsWithoutChange: 12,
  requestTimeoutMs: 600_000,
  commandTimeoutMs: 120_000,
};

export function configCandidates(cwd = process.cwd(), env = process.env) {
  const list = [];
  if (env.CREWLEAD_CONFIG) list.push(resolve(cwd, env.CREWLEAD_CONFIG));
  list.push(join(cwd, "crewlead.config.json"));
  list.push(join(cwd, ".crewlead", "config.json"));
  const xdg = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  list.push(join(xdg, "crewlead", "config.json"));
  return list;
}

export function loadConfig({ cwd = process.cwd(), env = process.env } = {}) {
  let raw = null;
  let source = "defaults";
  for (const file of configCandidates(cwd, env)) {
    if (!existsSync(file)) continue;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`crewlead: cannot parse ${file}: ${err.message}`);
    }
    source = file;
    break;
  }
  const config = normalize(raw ?? structuredClone(DEFAULT_CONFIG), env);
  config.source = source;
  return config;
}

export function normalize(raw, env = process.env) {
  const config = {
    providers: { ...(raw.providers ?? {}) },
    workers: { ...(raw.workers ?? {}) },
    defaultWorker: raw.defaultWorker,
  };

  // Env-only setup: one endpoint, no config file needed.
  if (env.CREWLEAD_BASE_URL || env.CREWLEAD_MODEL) {
    config.providers.env = {
      baseUrl: env.CREWLEAD_BASE_URL || "http://127.0.0.1:11434/v1",
      apiKeyEnv: "CREWLEAD_API_KEY",
      maxConcurrency: Number(env.CREWLEAD_MAX_CONCURRENCY) || 3,
    };
    config.workers.env = {
      provider: "env",
      model: env.CREWLEAD_MODEL || "qwen3.8:27b",
    };
    config.defaultWorker = "env";
  }
  if (env.CREWLEAD_WORKER) config.defaultWorker = env.CREWLEAD_WORKER;

  const names = Object.keys(config.workers);
  if (names.length === 0) throw new Error("crewlead: config has no workers");
  if (!config.defaultWorker) config.defaultWorker = names[0];

  for (const [name, p] of Object.entries(config.providers)) {
    if (!p.baseUrl) throw new Error(`crewlead: provider "${name}" needs a baseUrl`);
    p.baseUrl = p.baseUrl.replace(/\/+$/, "");
    p.maxConcurrency = Math.max(1, Number(p.maxConcurrency) || 2);
  }
  for (const [name, w] of Object.entries(config.workers)) {
    if (!w.model) throw new Error(`crewlead: worker "${name}" needs a model`);
    if (!config.providers[w.provider]) {
      throw new Error(`crewlead: worker "${name}" uses unknown provider "${w.provider}"`);
    }
    if (w.fallback && !config.workers[w.fallback]) {
      throw new Error(`crewlead: worker "${name}" has unknown fallback "${w.fallback}"`);
    }
    config.workers[name] = { ...WORKER_DEFAULTS, ...w };
  }
  if (!config.workers[config.defaultWorker]) {
    throw new Error(`crewlead: defaultWorker "${config.defaultWorker}" is not defined`);
  }
  return config;
}

export function resolveApiKey(provider, env = process.env) {
  if (provider.apiKeyEnv && env[provider.apiKeyEnv]) return env[provider.apiKeyEnv];
  if (provider.apiKey) return provider.apiKey;
  return null;
}

// Safe view for the orchestrator: never includes keys.
export function describeWorkers(config, env = process.env) {
  return Object.entries(config.workers).map(([name, w]) => {
    const p = config.providers[w.provider];
    return {
      name,
      default: name === config.defaultWorker,
      provider: w.provider,
      model: w.model,
      baseUrl: p.baseUrl,
      maxConcurrency: p.maxConcurrency,
      fallback: w.fallback ?? null,
      keyConfigured: p.apiKeyEnv || p.apiKey ? resolveApiKey(p, env) !== null : "not needed",
      description: w.description ?? null,
    };
  });
}
