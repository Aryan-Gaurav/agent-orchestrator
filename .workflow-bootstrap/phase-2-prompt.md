# Phase 2 — Engine + Approvals + CLI Integration

## Required Reading

1. `docs/workflow-engine.md` — design spec. Read it END-TO-END. Especially §4 (execution semantics), §5 (state management), §7 (CLI surface), §9 (module responsibilities — engine, approvals, cli, logger), §10 (Phase 2 acceptance).
2. **All existing Phase 0+1 modules in `packages/workflow/src/`** — read every file before designing the engine. You'll use:
   - `types.ts` — all type defs
   - `schema.ts` — `parseWorkflowDefinition`
   - `errors.ts` — error classes (add new ones as needed)
   - `artifact-store.ts` — hashing, copying, verification
   - `state-store.ts` — atomic state.json read/write
   - `selectors.ts` — `resolveSelector`
   - `prompt-template.ts` — `renderPrompt`, `appendExecutionContract`, `prependFeedback`
   - `ao-client.ts` — `createAoContext`, `spawnAgentSession`, `getSessionStatus`, `killSession`
   - `completion-detector.ts` — `waitForStepCompletion`
3. `CLAUDE.md` — repo conventions.

## Files to Create

1. **`packages/workflow/src/logger.ts`** (small)
   - Functions: `info(msg, ...)`, `warn(msg, ...)`, `error(msg, ...)`, `success(msg, ...)`, `step(label, msg)`
   - Use `chalk` (already a dep) for colored output to stderr
   - `--json` mode: if env var `AOW_JSON=1` (or pass flag down), emit one JSON line per call instead of formatted text
   - Keep under 80 LOC

2. **`packages/workflow/src/approvals.ts`** (per §4 + §9)
   - `enterGate(runDir: string, stepId: StepID, message: string, artifacts: string[]): Promise<void>` — writes `pending/<step>.json` and updates state to `awaiting_approval`
   - `decideGate(runDir: string, stepId: StepID, decision: { kind: "approve" } | { kind: "reject"; feedback: string }): Promise<void>` — updates state, removes pending file, writes feedback file if rejected
   - `readPendingGates(runDir: string): Promise<Array<{ stepId: StepID; message: string; awaiting_since: string }>>` — for `aow status`
   - File-based, no daemon. Approval comes from a separate `aow approve` invocation.

3. **`packages/workflow/src/engine.ts`** (the orchestrator — biggest module, but split if > 400 LOC)
   - Exported: `runWorkflow(opts: { workflowPath: string; runId?: string; selector: Selector; detach?: boolean }): Promise<RunResult>`
   - Run loop per §4:
     - Load `workflow.yaml` via `parseWorkflowDefinition`
     - Resolve or create run dir (`./.workflow-state/runs/<run-id>/`); pin definition.yaml snapshot
     - Load or create RunState
     - Hash workflow-level inputs from `workflow.inputs[]`; verify or update in state
     - Resolve selector → list of steps to run
     - Loop sequentially:
       - For each step in `pending` order with deps satisfied:
         - If `agent`: render prompt (template + execution contract + optional feedback), spawn AO session via `ao-client`, wait for completion via `completion-detector`, verify outputs, hash and record in state
         - If `human_approval`: call `enterGate`; if `detach` mode exit, else block waiting for state change (poll every 5s)
       - Mark step `completed` or `failed`
       - If failure: mark and exit loop
     - Apply `on_reject` loops: if a gate is rejected, target step → reset to `pending` with `attempts++` and feedback attached; cap at `max_revisions`
   - Helper functions in same file (or split into `engine/run-loop.ts`, `engine/step-runner.ts` if it grows large)
   - Resume semantics: if runId provided + exists, continue from current state
   - Error handling: any spawn/detect error → set step.failure_reason and mark failed

4. **`packages/workflow/src/cli.ts`** (per §7)
   - Commander setup. Each command is a thin wrapper.
   - Commands to implement in Phase 2:
     - `run <workflow> [--only|--from|--to|--through <step>] [--input <name>=<path>] [--detach]`
     - `resume <run-id>`
     - `status <run-id>` (or `status` with no arg = latest run)
     - `approve <run-id> <step-id>`
     - `reject <run-id> <step-id> -m <message>`
     - `show <run-id> [--step <id>] [--json]`
     - `list` (workflows in cwd)
     - `runs` (active + recent)
   - Use `commander` (already a dep)
   - First line of file: `#!/usr/bin/env node` so the bin shim works after build
   - On any unhandled error, log via `logger.error` and exit non-zero

5. **`packages/workflow/src/index.ts`** — update exports to include `runWorkflow`, approval helpers, logger if useful for library consumers. Don't break existing exports.

6. **`packages/workflow/src/__tests__/engine.integration.test.ts`** — end-to-end test against a mocked `ao-client`:
   - Fixture: a 2-step workflow (1 agent + 1 human_approval) in `__tests__/fixtures/hello-workflow.yaml`
   - Mock `@aoagents/ao-core` via vi.mock so the agent "spawn" doesn't actually launch anything; mock writes the expected output file after a short delay and returns idle activity
   - Test 1: full run → agent step completes → gate enters awaiting → call `decideGate(approve)` → workflow status `completed`
   - Test 2: rejection cycle → gate `reject` with feedback → agent step re-runs with feedback in prompt → outputs produced → approve → completed
   - Test 3: resume → kill mid-run (simulate by partial state) → `runWorkflow` with same runId resumes correctly
   - Use a temp directory (`fs.mkdtemp`) for each test; clean up after.

7. **`packages/workflow/examples/hello-world/workflow.yaml`** — minimal example used by tests + future demos
   - 1 agent step writing `hello.md`, 1 approval gate

8. **`packages/workflow/examples/hello-world/feature.md`** — placeholder input

## Hard Constraints

- Modify ONLY `packages/workflow/`. Add new files; modify only `index.ts` and `errors.ts` from existing.
- DO NOT import from `@aoagents/ao-core` anywhere except `ao-client.ts`. Engine, CLI, etc. all go through ao-client.
- All Phase 0+1 modules already exist — DO NOT redefine, reimplement, or "improve" them. Use them as-is.
- Strict TS. No `any`. Files max 400 LOC; split engine into submodules if needed (`engine/run-loop.ts`, `engine/step-runner.ts`, etc.).
- Update `package.json` `bin` field if needed — currently `bin.aow` → `./dist/cli.js`. After build, that path must exist and be executable (the `#!/usr/bin/env node` shebang handles this).
- The CLI doesn't need a real `aow` symlink for testing — `node packages/workflow/dist/cli.js <args>` is enough.

## Acceptance — All Must Pass

```bash
pnpm --filter @aoagents/ao-workflow build
pnpm --filter @aoagents/ao-workflow test     # all existing + new integration tests pass
pnpm typecheck                                # whole repo

# Manual smoke (document in PR body):
node packages/workflow/dist/cli.js --help
node packages/workflow/dist/cli.js run --help
```

## When Done

1. Verify all acceptance.
2. Commit: `feat(workflow): phase 2 — engine + approvals + CLI`
3. Push.
4. PR: `gh pr create --base feature/workflow-engine --title 'feat(workflow): phase 2 — engine + approvals + CLI'`
5. PR body should:
   - List files added
   - Confirm acceptance
   - Note: e2e test uses mocked ao-core; real AO integration smoke-test is Phase 3
   - Include the `--help` output (one screenshot or paste) so reviewers see CLI surface

## Out of Scope

- Real AO integration smoke (uses real spawn): Phase 3.
- Examples beyond hello-world: Phase 4.
- README, polish: Phase 4.
- Dashboard UI: not in roadmap for v1.
- Any file outside `packages/workflow/`.
