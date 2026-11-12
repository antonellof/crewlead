#!/usr/bin/env node
// Claude Code hook for boss mode. Boss mode is on when the file
// .crewlead/boss exists in the project or CREWLEAD_BOSS=1 is set.
//
// UserPromptSubmit: tells the lead up front that it must delegate, and names
//   the tools. Claude Code may defer MCP tools behind tool search, so without
//   this the lead tends to write code itself first and only find the
//   delegate tools after the PreToolUse deny.
// PreToolUse (Edit, Write, ...): denies the call.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TOOLS = [
  "mcp__plugin_crewlead_crewlead__delegate",
  "mcp__plugin_crewlead_crewlead__delegate_batch",
  "mcp__plugin_crewlead_crewlead__list_workers",
];

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch { /* no input: allow */ }

const dir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const on = process.env.CREWLEAD_BOSS === "1" || existsSync(join(dir, ".crewlead", "boss"));

if (on && input.hook_event_name === "UserPromptSubmit") {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext:
        "crewlead boss mode is on in this project. You are the lead: you plan, split and review, and worker models write every file. " +
        "Edit and Write are blocked for you, so do not draft file contents yourself. " +
        `Use the crewlead skill and send all file changes through these tools (load them with tool search if they are deferred): ${TOOLS.join(", ")}.`,
    },
  }));
} else if (on) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "crewlead boss mode is on: you plan and review, workers write. Send this change through the crewlead " +
        `delegate or delegate_batch tool (${TOOLS[0]}, ${TOOLS[1]}) with the exact edit you want.`,
    },
  }));
}
