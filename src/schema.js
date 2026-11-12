// Tool definitions shared by the MCP server and the Pi extension.

export const TASK_PROPERTIES = {
  task: {
    type: "string",
    description:
      "Self-contained instructions for the worker. It has no memory of your conversation, so include everything it needs: goal, file paths, expected behavior.",
  },
  context: {
    type: "string",
    description:
      "Interface contract shared with the other workers: function names, signatures, data shapes, file layout. Give every parallel worker the same contract.",
  },
  owns: {
    type: "array",
    items: { type: "string" },
    description:
      "Files or directories this worker may write, relative to cwd. Writes elsewhere are rejected. Parallel tasks must own disjoint paths.",
  },
  verify: {
    type: "string",
    description:
      "Shell command that must exit 0 before the work is accepted, for example 'node --test test/parser.test.js'. On failure the worker gets the output and retries locally.",
  },
  worker: {
    type: "string",
    description: "Worker profile name from the config. Omit for the default. Call list_workers to see the options.",
  },
  cwd: { type: "string", description: "Working directory, relative to the project root. Default: project root." },
  id: { type: "string", description: "Short label for this task, echoed in the result." },
};

export const TOOLS = [
  {
    name: "delegate",
    description:
      "Hand one coding task to a worker model (local or remote, as configured). The worker runs its own read/edit/run loop and returns a short report, the changed files and the verify result. Use it for implementation work you have already specified.",
    inputSchema: { type: "object", properties: TASK_PROPERTIES, required: ["task"] },
  },
  {
    name: "delegate_batch",
    description:
      "Run several worker tasks in parallel and wait for all of them. Split the work so each task owns different files, and give all tasks the same interface contract in 'context'.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          items: { type: "object", properties: TASK_PROPERTIES, required: ["task"] },
        },
      },
      required: ["tasks"],
    },
  },
  {
    name: "list_workers",
    description: "List the configured worker profiles: name, provider, model, concurrency, fallback.",
    inputSchema: { type: "object", properties: {} },
  },
];

export const GUIDELINES = `You are the lead. Workers are cheaper models that build what you specify.
1. Plan first. Split the job into tasks that touch different files.
2. Write the interface contract once (names, signatures, data shapes, paths) and pass it as 'context' to every task.
3. Give each task 'owns' paths and, when possible, a 'verify' command.
4. Send parallel work with delegate_batch. Do not write the code yourself.
5. Review the reports and the diff. Send fixes back as new tasks with the exact error or the exact change you want.`;
