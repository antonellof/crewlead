// One worker = one agent loop against one OpenAI-compatible endpoint.
// The loop ends when the model stops calling tools. If the task has a verify
// command, the loop only ends when that command passes or retries run out.

import { chat } from "./llm.js";
import { TOOL_SCHEMAS, createToolbox, runCommand } from "./tools.js";

const SYSTEM_PROMPT = `You are a builder on a software team. A lead engineer gave you one task.
Do exactly that task with the tools you have. Rules:
- Read the relevant files before you change them.
- Write complete, working code. No placeholders, no TODO stubs.
- Stay inside the files you own. If you need a change elsewhere, do not make it. Report it.
- Follow the interface contract in the task exactly: names, signatures, file paths.
- When you are done, stop calling tools and reply with a short report:
  what you built, which files you changed, anything the lead must know.
Keep the report under 150 words.`;

export async function runWorker({ task, worker, provider, cwd, signal, env, onEvent = () => {} }) {
  const started = Date.now();
  const toolbox = createToolbox({
    cwd,
    owns: task.owns ?? [],
    allowShell: task.allowShell ?? worker.allowShell ?? true,
    commandTimeoutMs: worker.commandTimeoutMs,
    signal,
  });
  const usage = { promptTokens: 0, completionTokens: 0, costUsd: 0, costKnown: false };
  const messages = [
    { role: "system", content: worker.systemPrompt ?? SYSTEM_PROMPT },
    { role: "user", content: renderTask(task) },
  ];

  let steps = 0;
  let verifyRuns = 0;
  let verify = null;
  let status = "max_steps";
  let report = "";

  while (steps < worker.maxSteps) {
    steps++;
    const res = await chat({ provider, worker, messages, tools: TOOL_SCHEMAS, signal, env });
    usage.promptTokens += res.usage.promptTokens;
    usage.completionTokens += res.usage.completionTokens;
    if (res.usage.costUsd !== null) {
      usage.costUsd += res.usage.costUsd;
      usage.costKnown = true;
    }

    const msg = res.message;
    const calls = msg.tool_calls ?? [];
    messages.push({ role: "assistant", content: msg.content ?? "", ...(calls.length ? { tool_calls: calls } : {}) });

    if (calls.length > 0) {
      for (const call of calls) {
        onEvent({ type: "tool", id: task.id, name: call.function?.name });
        const output = await toolbox.call(call.function?.name, call.function?.arguments);
        messages.push({ role: "tool", tool_call_id: call.id, content: output });
      }
      continue;
    }

    report = stripThinking(msg.content ?? "");

    if (!task.verify) {
      status = "done";
      break;
    }
    verifyRuns++;
    onEvent({ type: "verify", id: task.id, attempt: verifyRuns });
    const r = await runCommand(task.verify, { cwd, timeoutMs: worker.commandTimeoutMs, signal });
    verify = { command: task.verify, passed: r.code === 0, attempts: verifyRuns, output: tail(r.output, 1500) };
    if (verify.passed) {
      status = "done";
      break;
    }
    if (verifyRuns > worker.verifyRetries) {
      status = "verify_failed";
      break;
    }
    messages.push({
      role: "user",
      content: `The check \`${task.verify}\` failed with exit code ${r.code}:\n\n${tail(r.output, 4000)}\n\nFix the problem, then report again.`,
    });
  }

  if (!usage.costKnown && (worker.inputPricePerM || worker.outputPricePerM)) {
    usage.costUsd =
      (usage.promptTokens / 1e6) * (worker.inputPricePerM ?? 0) +
      (usage.completionTokens / 1e6) * (worker.outputPricePerM ?? 0);
    usage.costKnown = true;
  }

  return {
    id: task.id,
    status,
    report: report || "(the worker gave no report)",
    filesChanged: [...toolbox.changed].sort(),
    verify,
    steps,
    model: worker.model,
    usage: {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      costUsd: usage.costKnown ? round(usage.costUsd) : null,
    },
    seconds: Math.round((Date.now() - started) / 100) / 10,
  };
}

function renderTask(task) {
  const parts = [`# Task\n${task.task}`];
  if (task.context) parts.push(`# Context and interface contract\n${task.context}`);
  if (task.owns?.length) parts.push(`# Files you own\nYou may only write to: ${task.owns.join(", ")}`);
  if (task.verify) parts.push(`# Check\nYour work is accepted when this command exits with code 0:\n${task.verify}`);
  return parts.join("\n\n");
}

// Some local models leak their reasoning into the content field.
function stripThinking(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

function tail(text, max) {
  return text.length <= max ? text : `[...]\n${text.slice(-max)}`;
}

function round(n) {
  return Math.round(n * 10000) / 10000;
}
