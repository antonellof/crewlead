---
name: crewlead
description: Delegate implementation work to cheaper worker models through the crewlead delegate and delegate_batch tools, and set up crewlead with its setup tool. Use when the user asks to set up or configure crewlead or its workers, when the user asks to build, implement, scaffold or refactor code and crewlead tools are available, when the user mentions workers, builders, local models or boss mode, or when a write is blocked by crewlead boss mode.
---

# Crewlead: you lead, workers build

You are the lead engineer. Worker models (local or remote, set in the user's config) write the code. Your tokens are expensive and theirs are cheap, so spend yours on planning and review.

## Workflow

1. Understand the job. Read what you need. Do not read files a worker can read for itself.
2. Split the job into tasks that write different files. Aim for 2 to 6 tasks per batch.
3. Write one interface contract: file layout, function names, signatures, data shapes, shared constants. Workers cannot see each other, so the contract is the only thing that makes their parts fit.
4. Call `delegate_batch`. For each task set:
   - `task`: complete instructions. The worker knows nothing about this conversation.
   - `context`: the same contract for every task.
   - `owns`: the files or directories that task may write. No overlap between parallel tasks.
   - `verify`: a command that exits 0 when the work is right (a test file, a type check, a lint run).
5. Read the results. Each one has a status, a short report, changed files and the verify result. Check the integration yourself: run the full test suite or open the diff.
6. Fix by delegating again. Quote the exact error and name the exact change. Retries on workers cost little.

## Setup

When the user asks to set up crewlead, or `list_workers` reports `configSource: "defaults"`:

1. Call `setup` with `action: "detect"`. Show the user the servers found, which key variables are set, and the suggested config.
2. If it looks right, call `setup` with `action: "write"`. Omit `config` to write the suggestion. Leave `scope` out: it writes to this project. Use `scope: "user"` only when the user asks for a setup that applies to all projects. Pass `overwrite: true` only if the user agrees to replace an existing file.
3. Report the check result. A worker with `toolCalling: false` cannot edit files.

If nothing is found, tell the user to start a local server or export a key such as `OPENROUTER_API_KEY`, then detect again. Never put an API key in the config.

## Rules

- Do not write implementation code yourself when a worker can do it. Small glue edits are fine unless boss mode is on.
- If boss mode blocks an edit, send that edit as a `delegate` task.
- A worker that fails twice on the same task needs a smaller task or a clearer contract, not a third identical attempt.
- Call `list_workers` once if you need to pick a profile. Omit `worker` to use the default.
- A status of `verify_failed`, `max_steps` or `error` means the work is not done. Say so to the user. Do not report it as finished.

## Writing a good task

Bad: "Implement the parser."

Good: "Create src/parser.js exporting `parse(text: string): Node[]`. A Node is `{type: 'heading'|'para', level?: number, text: string}`. Lines starting with 1 to 6 `#` characters are headings. Blank lines separate paragraphs. Create test/parser.test.js with node:test covering headings, paragraphs and empty input."
