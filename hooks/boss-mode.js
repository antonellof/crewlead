#!/usr/bin/env node
// Claude Code PreToolUse hook. When boss mode is on, the lead model cannot
// edit files itself and has to delegate. Boss mode is on when the file
// .capomastro/boss exists in the project or CAPOMASTRO_BOSS=1 is set.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch { /* no input: allow */ }

const dir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const on = process.env.CAPOMASTRO_BOSS === "1" || existsSync(join(dir, ".capomastro", "boss"));

if (on) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "capomastro boss mode is on: you plan and review, workers write. Send this change through the capomastro delegate or delegate_batch tool with the exact edit you want.",
    },
  }));
}
