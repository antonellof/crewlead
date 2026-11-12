# capomastro

One lead model plans and reviews. Cheap workers write the code in parallel.

A *capomastro* is the master builder on an Italian construction site: one person reads the plans and gives the orders, the crew lays the bricks. This project does the same with LLMs. Your expensive model (Claude, GPT, anything) stays in your coding agent as the lead. Light worker models, local or remote, do the typing and the retries.

Works with **Claude Code** (plugin), **Codex** (MCP server) and **Pi** (native extension). Zero npm dependencies. Node 20.3 or newer.

```
 Claude Code / Codex / Pi  (lead: plans, splits, reviews)
            |
            |  delegate_batch([task A, task B, task C])
            v
       capomastro pool  (concurrency cap per provider, fallback)
        |        |        |
     worker A  worker B  worker C     each: read -> edit -> run -> verify -> retry
        |        |        |
   llama.cpp / Ollama / LM Studio / vLLM / OpenRouter / any OpenAI-compatible API
```

## Why

The lead model is the expensive part of an agent run. Most of its output tokens go into typing code it has already designed. Capomastro moves that typing to a worker:

- The lead writes a contract and a task list, then reads short reports. It never streams file contents.
- Each worker runs its own agent loop and only returns a summary, the changed files and a test result.
- A failed check is fed back to the worker, which retries on its own. On a local model those retries cost nothing.

## Workers: local, remote, or both

A worker is a profile in a config file: a provider (any OpenAI-compatible endpoint) plus a model. Mix local and remote freely.

```json
{
  "providers": {
    "local": {
      "baseUrl": "http://127.0.0.1:8080/v1",
      "maxConcurrency": 3
    },
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "maxConcurrency": 8
    }
  },
  "workers": {
    "builder": {
      "provider": "local",
      "model": "qwen3.8-27b",
      "fallback": "builder-remote"
    },
    "builder-remote": {
      "provider": "openrouter",
      "model": "qwen/qwen3.8-27b"
    }
  },
  "defaultWorker": "builder"
}
```

With this file, tasks go to the local server, three at a time. If the local server is down, each task moves to OpenRouter. The lead can also pick a profile per task with `"worker": "builder-remote"`.

Create the file with `capomastro init`. Lookup order:

1. `$CAPOMASTRO_CONFIG`
2. `./capomastro.config.json`
3. `./.capomastro/config.json`
4. `~/.config/capomastro/config.json`

No file at all? Capomastro uses Ollama at `127.0.0.1:11434` with `qwen3.8:27b`. Or set one endpoint with environment variables: `CAPOMASTRO_BASE_URL`, `CAPOMASTRO_MODEL`, `CAPOMASTRO_API_KEY`, `CAPOMASTRO_MAX_CONCURRENCY`.

### Provider options

| Field | Meaning |
| --- | --- |
| `baseUrl` | OpenAI-compatible base URL, ending in `/v1` |
| `apiKeyEnv` | Name of the environment variable holding the key. Keep keys out of the file. |
| `maxConcurrency` | Max parallel workers on this provider. Match it to your server's parallel slots. Default 2. |
| `headers` | Extra HTTP headers, for example OpenRouter's `HTTP-Referer` and `X-Title` |

### Worker options

| Field | Default | Meaning |
| --- | --- | --- |
| `provider`, `model` | required | Where the worker runs |
| `fallback` | none | Worker profile to use when this provider is unreachable or rejects the key |
| `temperature` | 0.2 | |
| `maxSteps` | 40 | Max model turns per task |
| `maxTokens` | 8192 | Max output tokens per turn |
| `verifyRetries` | 3 | Extra attempts after a failed verify command |
| `allowShell` | true | Set false to remove the `run` tool |
| `inputPricePerM`, `outputPricePerM` | none | USD per million tokens, for the cost report when the API does not return a cost |
| `extraBody` | none | Extra fields merged into the request, for example `{"reasoning": {"effort": "low"}}` |
| `systemPrompt` | built in | Replace the worker's system prompt |

Check your setup with `capomastro doctor`. It sends one request per worker and tells you if the model supports tool calling. A model without tool calling cannot edit files.

## Install

### Claude Code

```
/plugin marketplace add antonellof/capomastro
/plugin install capomastro@capomastro
```

The plugin registers three things: the MCP server, a skill that teaches the lead how to delegate, and a hook for boss mode.

Long batches can exceed the default MCP tool timeout. Start Claude Code with `MCP_TOOL_TIMEOUT=1800000` if workers get cut off.

**Boss mode.** Run `capomastro boss on` in a project (or set `CAPOMASTRO_BOSS=1`). The hook then blocks `Edit` and `Write` for the lead, so every change has to go through a worker. `capomastro boss off` turns it off.

### Codex

Clone the repo, then add the block from [`codex/config.example.toml`](codex/config.example.toml) to `~/.codex/config.toml`. Paste [`codex/AGENTS.snippet.md`](codex/AGENTS.snippet.md) into your `AGENTS.md` so the lead knows how to delegate.

### Pi

```
pi install git:github.com/antonellof/capomastro
```

The extension registers `delegate`, `delegate_batch` and `list_workers` as native tools, plus a `/workers` command. No MCP involved.

### Standalone

```
git clone https://github.com/antonellof/capomastro && cd capomastro
node bin/capomastro.js init
node bin/capomastro.js doctor
node bin/capomastro.js run "Create fizzbuzz.js and a node:test file for it" --verify "node --test"
```

## Tools the lead gets

**`delegate`** runs one task. **`delegate_batch`** runs many in parallel and waits for all. A task has these fields:

| Field | Meaning |
| --- | --- |
| `task` | Complete instructions. The worker knows nothing about the lead's conversation. |
| `context` | The interface contract. Give the same text to every parallel task. |
| `owns` | Paths the worker may write. Writes elsewhere are rejected. |
| `verify` | Command that must exit 0. On failure the worker gets the output and retries. |
| `worker` | Profile name. Omit for the default. |
| `cwd`, `id` | Working directory and a label |

A result looks like this:

```json
{
  "id": "parser",
  "status": "done",
  "report": "Built src/parser.js with parse(). 6 tests pass.",
  "filesChanged": ["src/parser.js", "test/parser.test.js"],
  "verify": { "command": "node --test test/parser.test.js", "passed": true, "attempts": 2 },
  "steps": 9,
  "worker": "builder",
  "provider": "local",
  "model": "qwen3.8-27b",
  "usage": { "promptTokens": 41250, "completionTokens": 3120, "costUsd": null },
  "seconds": 74.2
}
```

`status` is `done`, `verify_failed`, `max_steps` or `error`. Only `done` means the work was accepted.

**`list_workers`** shows the configured profiles. It never returns keys.

## Running local workers

Serve one model with several parallel slots. All workers then share one copy of the weights.

```
llama-server -m qwen3.8-27b-Q4_K_M.gguf --jinja -c 196608 -np 3 --port 8080
```

`-np 3` gives three slots and splits the context between them, so size `-c` for three workers. Set the provider's `maxConcurrency` to the same number. The model must support tool calling through the chat template (`--jinja` in llama.cpp).

## Safety

- File tools resolve every path inside the task's working directory. Paths that leave it, directly or through a symlink, are rejected.
- `owns` limits where a worker can write with the file tools.
- The `run` tool is a real shell with your permissions. A worker can do anything you can do from that shell, and `owns` does not restrict it. Use `"allowShell": false` on a profile, or run your agent in a container, when you do not trust the model or the task.
- With a remote provider, the worker sends file contents from your project to that provider.
- Two parallel tasks that own the same path will overwrite each other. `delegate_batch` warns about overlaps and still runs.

## Status

Version 0.1. The test suite (`npm test`) runs the worker loop, the pool, the fallback path, the MCP server and the boss hook against a mock OpenAI-compatible server. It has not been benchmarked against real models yet, so there are no cost or speed numbers here.

Planned: git worktree isolation per worker, async dispatch with polling for hosts with short tool timeouts, a run log with per-task cost, headless Pi as an alternative worker runtime.

## License

MIT
