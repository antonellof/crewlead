// One worker = one agent loop against one OpenAI-compatible endpoint.
// The loop ends when the model stops calling tools. If the task has a verify
// command, the loop only ends when that command passes or retries run out.

import { chat, ContextOverflowError } from "./llm.js";
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
  let lastPromptTokens = 0;
  let warned = false;
  let lastCall = null;
  const toolCalls = {};

  while (steps < worker.maxSteps) {
    steps++;
    if (!warned && worker.maxSteps - steps === 2) {
      warned = true;
      messages.push({
        role: "user",
        content: "You have 3 turns left. Write any file you have not written yet, then stop calling tools and give your report.",
      });
    }
    // Shrink the history before it reaches the context limit, when known.
    if (worker.contextTokens && lastPromptTokens > worker.contextTokens * 0.7 && compact(messages)) {
      onEvent({ type: "compact", id: task.id });
    }

    let res;
    try {
      res = await chat({ provider, worker, messages, tools: TOOL_SCHEMAS, signal, env });
    } catch (err) {
      if (!(err instanceof ContextOverflowError)) throw err;
      onEvent({ type: "compact", id: task.id });
      if (!compact(messages) && !compact(messages, 2)) {
        throw new Error(`the conversation does not fit the model's context even after dropping old tool output: ${err.message}`);
      }
      steps--; // the overflowed request produced nothing, do not charge a step
      continue;
    }
    lastPromptTokens = res.usage.promptTokens;
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
        const name = call.function?.name;
        onEvent({ type: "tool", id: task.id, name });
        toolCalls[name] = (toolCalls[name] ?? 0) + 1;
        const output = await toolbox.call(name, call.function?.arguments);
        lastCall = { name, arguments: call.function?.arguments ?? "", output };
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

  if (status === "max_steps") report = describeUnfinished({ steps, toolCalls, lastCall, messages, changed: toolbox.changed });

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
    toolCalls,
    model: worker.model,
    usage: {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      costUsd: usage.costKnown ? round(usage.costUsd) : null,
    },
    seconds: Math.round((Date.now() - started) / 100) / 10,
  };
}

// Drop old tool output and the bodies of old file writes so the conversation
// fits the context again. The system prompt, the task and the most recent
// `keep` messages stay intact. Returns true when anything got smaller.
export function compact(messages, keep = 6) {
  let changed = false;
  const end = messages.length - keep;
  for (let i = 2; i < end; i++) {
    const m = messages[i];
    if (m.role === "tool" && typeof m.content === "string" && m.content.length > 400 && !m.content.includes(DROPPED)) {
      m.content = `${m.content.slice(0, 200)}\n[${DROPPED}: ${m.content.length} characters. Run the tool again if you need it.]`;
      changed = true;
    }
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const call of m.tool_calls) {
        const raw = call.function?.arguments;
        if (typeof raw !== "string" || raw.length <= 400) continue;
        let args;
        try {
          args = JSON.parse(raw);
        } catch {
          args = null;
        }
        const slim = args && typeof args === "object" ? { ...args } : {};
        for (const key of ["content", "old_string", "new_string"]) {
          if (typeof slim[key] === "string" && slim[key].length > 200) slim[key] = `[${DROPPED}: ${slim[key].length} characters, already applied]`;
        }
        const next = JSON.stringify(slim);
        if (next.length < raw.length) {
          call.function.arguments = next;
          changed = true;
        }
      }
    }
  }
  return changed;
}

const DROPPED = "dropped to save context";

// A max_steps result must tell the lead what the worker was doing.
function describeUnfinished({ steps, toolCalls, lastCall, messages, changed }) {
  const counts = Object.entries(toolCalls).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} x${c}`).join(", ") || "none";
  const lastText = [...messages].reverse().find((m) => m.role === "assistant" && m.content)?.content ?? "";
  const parts = [
    `Stopped after ${steps} steps without finishing.`,
    `Tool calls: ${counts}.`,
    `Files written: ${changed.size ? [...changed].sort().join(", ") : "none"}.`,
  ];
  if (lastCall) {
    parts.push(`Last call: ${lastCall.name} ${lastCall.arguments.slice(0, 200)} -> ${lastCall.output.slice(0, 300).replace(/\s+/g, " ")}`);
  }
  if (stripThinking(lastText)) parts.push(`Last message: ${stripThinking(lastText).slice(0, 300)}`);
  return parts.join("\n");
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
