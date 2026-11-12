# Setup recipes

Pick a host (where the lead runs), then a worker setup (where the code gets written). Any host works with any worker setup.

The quickest path in every host is to ask the lead to **set up crewlead**: the `setup` tool finds local servers, sees which key variables are set and writes the config. The files below are for when you want to write or adjust the config yourself. Every file in [`examples/configs/`](../examples/configs/) is checked by the test suite.

What has been run for real so far is in [testing.md](testing.md). In short: Claude Code with llama.cpp workers. Codex, Pi and live OpenRouter workers are written from their documentation and not yet run.

## Hosts

### Claude Code

```
/plugin marketplace add antonellof/crewlead
/plugin install crewlead@crewlead
```

Remote keys come from the shell that starts Claude Code:

```
export OPENROUTER_API_KEY=...        # in ~/.zshrc or ~/.bashrc
export MCP_TOOL_TIMEOUT=1800000      # long batches
claude
```

Then: `set up crewlead`. Boss mode: `npx -y github:antonellof/crewlead boss on`.

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.crewlead]
command = "npx"
args = ["-y", "github:antonellof/crewlead", "mcp"]
startup_timeout_sec = 30
tool_timeout_sec = 1800
env_vars = ["OPENROUTER_API_KEY"]
```

`env_vars` forwards the variable from the shell that starts Codex, so the key value never lands in `config.toml` ([Codex MCP docs](https://developers.openai.com/codex/mcp)). Do not use a `[mcp_servers.crewlead.env]` table for keys: it stores the value in the file.

Add [`codex/AGENTS.snippet.md`](../codex/AGENTS.snippet.md) to your `AGENTS.md`, start Codex from a shell where the key is exported, then ask: `set up crewlead`.

### Pi

```
pi install git:github.com/antonellof/crewlead
```

The extension runs inside Pi, so it sees the environment of the shell that started Pi. Export keys before starting it. Then ask `set up crewlead`, or run `/workers` to see the active profiles.

### Command line, no agent

```
npx -y github:antonellof/crewlead init       # writes crewlead.config.json
npx -y github:antonellof/crewlead doctor
npx -y github:antonellof/crewlead run "Add a --json flag to src/cli.js" --verify "npm test" --owns src/cli.js
```

## Worker setups

Copy a file to `crewlead.config.json` in your project, or to `~/.config/crewlead/config.json` for every project.

### Local llama.cpp, one machine: [`local-llamacpp.json`](../examples/configs/local-llamacpp.json)

```
llama-server -hf unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL --jinja -c 196608 -np 3 --port 8080
```

Three workers at once, 65,536 tokens of context each, thinking off. This is what `setup` writes on a Mac with that server running, and the setup the pop-up book run used.

### MLX on Apple Silicon: [`mac-mlx.json`](../examples/configs/mac-mlx.json)

```
brew install uv
APC_ENABLED=1 uv run --python 3.12 --with mlx-vlm==0.7.12 -- python -m mlx_vlm.server \
  --model robgaleano/Swift-1.5-Qwen3.8-27B-MLX-8bit --max-num-seqs 3 --prefill-step-size 4096 --max-tokens 32768 --host 127.0.0.1 --port 8080
```

Three parallel workers on 8-bit weights. Set `maxConcurrency` to `--max-num-seqs`. Measurements against llama.cpp, and when to add the MTP drafter: [README, Best setup on a Mac](../README.md#best-setup-on-a-mac). The Swift 1.5 fine-tune has its own license (free up to US$1M annual revenue).

### Ollama: [`local-ollama.json`](../examples/configs/local-ollama.json)

```
ollama pull qwen3.8:27b
OLLAMA_NUM_PARALLEL=2 ollama serve
```

Keep `maxConcurrency` equal to `OLLAMA_NUM_PARALLEL`. This file does not turn thinking off; how to do that through Ollama's OpenAI-compatible endpoint has not been checked yet.

### LM Studio: [`local-lmstudio.json`](../examples/configs/local-lmstudio.json)

Start the server in LM Studio's developer tab (port 1234) and copy the model id from `GET http://127.0.0.1:1234/v1/models` into `model`.

### OpenRouter only, no GPU: [`openrouter-only.json`](../examples/configs/openrouter-only.json)

```
export OPENROUTER_API_KEY=...
```

Two profiles: `builder` (Qwen 3.8 27B, $0.15 in / $1.875 out per million tokens) and `fast` (Qwen 3.6 35B A3B, $0.10 / $0.90), prices as listed by OpenRouter on 2026-11-12. The lead picks `fast` per task with `"worker": "fast"`. Raise `maxConcurrency` as far as your rate limit allows: remote workers do not share a GPU.

### Local first, OpenRouter fallback: [`local-with-openrouter-fallback.json`](../examples/configs/local-with-openrouter-fallback.json)

Tasks run on the local server. When it is down or rejects the request, each task moves to the same model on OpenRouter. The lead can also send a whole batch to `builder-remote` when three local slots would make it queue.

### Two machines: [`two-machines.json`](../examples/configs/two-machines.json)

Run `llama-server ... --host 0.0.0.0` on the second machine and put its LAN address in `baseUrl`. Each provider has its own concurrency cap. The lead spreads a batch with `"worker": "builder-laptop"` on some tasks; if this machine's server is down, tasks fall back to the laptop.

### Any other OpenAI-compatible provider: [`any-openai-compatible.json`](../examples/configs/any-openai-compatible.json)

Anything that serves `POST /v1/chat/completions` with tool calling works: vLLM, a hosted inference API, a company gateway. Set `baseUrl`, put the key's variable name in `apiKeyEnv`, copy the model id from the provider's model list, then run `crewlead doctor`. It reports `tool calling: NO` for models that cannot call tools, which cannot edit files.

## Checking a setup

```
npx -y github:antonellof/crewlead workers   # profiles, concurrency, whether each key is set
npx -y github:antonellof/crewlead doctor    # one tool-calling request per worker
```

Or ask the lead: `which crewlead workers do I have, and are they working?`
