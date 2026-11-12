// Minimal OpenAI-compatible chat client. Works with llama.cpp, Ollama,
// LM Studio, vLLM, OpenRouter and anything else that speaks
// POST {baseUrl}/chat/completions with tool calling.

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { resolveApiKey } from "./config.js";

export class ProviderUnreachableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "ProviderUnreachableError";
    this.cause = cause;
  }
}

// The request did not fit the model's context window. The caller can shrink
// the conversation and try again.
export class ContextOverflowError extends Error {
  constructor(message) {
    super(message);
    this.name = "ContextOverflowError";
  }
}

// llama.cpp: exceed_context_size_error. OpenAI and most proxies:
// context_length_exceeded / "maximum context length". vLLM and others
// phrase it in a few more ways.
const CONTEXT_OVERFLOW = /exceed_context_size|context_length_exceeded|maximum context length|exceeds the available context|context window|too many tokens|prompt is too long/i;

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
      res = await post(`${provider.baseUrl}/chat/completions`, headers, JSON.stringify(body), combined);
    } catch (err) {
      if (signal?.aborted) throw err;
      if (timeout.aborted) {
        // The server took the whole budget. Sending the same request again
        // would take as long, so give up on this one.
        throw new Error(`${provider.baseUrl} did not answer within ${Math.round(worker.requestTimeoutMs / 1000)} s (requestTimeoutMs)`);
      }
      const code = err.code ?? err.cause?.code;
      lastError = new ProviderUnreachableError(`cannot reach ${provider.baseUrl}: ${code ?? err.message}`, err);
      // Connection refused will not fix itself in two seconds; fail fast so
      // the fallback worker can take over.
      if (code === "ECONNREFUSED" || code === "ENOTFOUND") throw lastError;
      continue;
    }
    if (!res.ok) {
      const text = res.text.slice(0, 500);
      lastError = new Error(`${provider.baseUrl} returned ${res.status}: ${text}`);
      if ((res.status === 400 || res.status === 413) && CONTEXT_OVERFLOW.test(text)) {
        throw new ContextOverflowError(lastError.message);
      }
      if (res.status === 401 || res.status === 403) {
        throw new ProviderUnreachableError(lastError.message);
      }
      if (RETRY_STATUS.has(res.status)) continue;
      throw lastError;
    }
    let data;
    try {
      data = JSON.parse(res.text);
    } catch {
      lastError = new Error(`malformed response from ${provider.baseUrl}: ${res.text.slice(0, 300)}`);
      continue;
    }
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

// POST with node:http rather than fetch. fetch (undici) gives up after 300 s
// without response headers, and a non-streaming completion sends no headers
// until it is done: a worker writing a long file on a local model takes
// longer than that. Here only requestTimeoutMs applies.
function post(url, headers, body, signal) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const send = u.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(u, { method: "POST", headers: { ...headers, "content-length": Buffer.byteLength(body) }, signal }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, text }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
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
