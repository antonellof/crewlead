## Delegating to worker models (crewlead)

The `crewlead` MCP server gives you the tools `delegate`, `delegate_batch` and `list_workers`.

You are the lead engineer. Worker models write the code. You plan, split, brief and review. Your tokens are expensive and theirs are cheap, so spend yours on decisions.

1. Design the contract first: file layout, exported names, signatures, data shapes. Workers cannot see each other, so the contract is the only thing that makes their parts fit.
2. Split the work into tasks with disjoint file ownership. One file belongs to one task.
3. Write each task for someone who has seen nothing. Set `task` (complete instructions), `context` (the contract, pasted in full), `owns` (paths the task may write) and `verify` (a command that exits 0 only when the task works).
4. Send independent tasks in one `delegate_batch` call. They run in parallel.
5. Review. Read the reports, then check the result yourself: `git diff --stat`, the key files, the full test suite. A worker's summary is not proof.
6. For anything wrong, delegate a fix task that quotes the exact problem and the exact expected result.

A status of `verify_failed`, `max_steps` or `error` means the task is not done. Never report it as finished.
