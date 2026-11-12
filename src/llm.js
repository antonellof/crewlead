// Minimal OpenAI-compatible chat client. Works with llama.cpp, Ollama,
// LM Studio, vLLM, OpenRouter and anything else that speaks
// POST {baseUrl}/chat/completions with tool calling.

import { resolveApiKey } from "./config.js";

export class ProviderUnreachableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "ProviderUnreachableError";
    this.cause = cause;
  }
}

const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export async function chat({ provider, worker, messages, tools, signal, env = process.env }) {
  const headers = { "content-type": "application/json", ...(provider.headers ?? {}) };
  const key = resolveApiKey(provider, env);
  if (key) headers.authorization = `Bearer ${key}`;
  else if (provider.apiKeyEnv) {
    throw new ProviderUnreachableError(
      `missing API key: set ${provider.apiKeyEnv} for provider at ${provider.baseUrl}`,
    );
  }

  const body = {
    model: worker.model,
    messages,
    temperature: worker.temperature,
    max_tokens: worker.maxTokens,
    ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
    ...(worker.extraBody ?? {}),
  };

  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** attempt, signal);
    const timeout = AbortSignal.timeout(worker.requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res;
    try {
      res = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = new ProviderUnreachableError(
        `cannot reach ${provider.baseUrl}: ${err.cause?.code ?? err.message}`,
        err,
      );
      // Connection refused will not fix itself in two seconds; fail fast so
      // the fallback worker can take over.
      if (err.cause?.code === "ECONNREFUSED" || err.cause?.code === "ENOTFOUND") throw lastError;
      continue;
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 500);
      lastError = new Error(`${provider.baseUrl} returned ${res.status}: ${text}`);
      if (res.status === 401 || res.status === 403) {
        throw new ProviderUnreachableError(lastError.message);
      }
      if (RETRY_STATUS.has(res.status)) continue;
      throw lastError;
    }
    const data = await res.json();
    const choice = data.choices?.[0];
    if (!choice?.message) {
      lastError = new Error(`malformed response from ${provider.baseUrl}: ${JSON.stringify(data).slice(0, 300)}`);
      continue;
    }
    return {
      message: choice.message,
      finishReason: choice.finish_reason,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        // OpenRouter reports real cost when available.
        costUsd: typeof data.usage?.cost === "number" ? data.usage.cost : null,
      },
    };
  }
  throw lastError;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error("aborted"));
    }, { once: true });
  });
}
