# Phase 0 — Workflow Engine Foundation

You are building the foundation of a new extension package for Agent Orchestrator (AO).

## Required Reading (do this first, in full)

1. `docs/workflow-engine.md` — the complete design spec. This is the source of truth. Read all of it before you write any code.
2. `CLAUDE.md` — repo-wide conventions (TS strict, no `any`, no inline styles, max 400 LOC per file).
3. `docs/PLUGIN_SPEC.md` — for context on how plugins are structured (we are NOT building a plugin, but the patterns inform code style).
4. Skim `packages/cli/package.json` and `packages/cli/tsconfig.json` — use them as the template for ours.

## Your Task: Phase 0 Only

Create a new package at `packages/workflow/` containing ONLY the foundation files. Do not build the engine, CLI, state store, or runtime logic yet — those are later phases.

### Files to create

1. **`packages/workflow/package.json`**
   - Name: `@aoagents/ao-workflow`
   - Bin: `aow` → `./dist/cli.js`
   - Dependencies: `@aoagents/ao-core` (workspace:*), `commander`, `zod`, `yaml`, `chalk`
   - Dev dependencies match `packages/cli/package.json` (vitest, tsx, typescript versions)
   - Scripts: `build`, `test`, `typecheck`, `lint` matching siblings

2. **`packages/workflow/tsconfig.json`** — extend `../../tsconfig.base.json`, output to `dist/`, include `src/`

3. **`packages/workflow/src/types.ts`** — all type definitions described in §9 of the design doc. Specifically:
   - `WorkflowDefinition`, `WorkflowStep`, `AgentStep`, `ApprovalStep`
   - `RunState`, `StepState`, `StepStatus` (use string literal union per design doc)
   - `AttemptRecord` with session_id, branch, started_at, completed_at, inputs[], outputs[]
   - `Artifact` (name, path, hash) and `ArtifactRef`
   - `Selector`, `SelectorKind` (one of "all" | "only" | "from" | "to" | "through" | "rerun")
   - Branded types for `StepID`, `RunID`, `WorkflowID` (or simple `type X = string`, your call — be consistent)
   - No runtime logic. Pure types + interfaces.

4. **`packages/workflow/src/errors.ts`** — error classes:
   - `WorkflowError` (base)
   - `WorkflowValidationError extends WorkflowError` (carries fieldPath, message)
   - `WorkflowCycleError extends WorkflowError`
   - `StepNotFoundError extends WorkflowError`
   - Each with a `code` field (e.g., `WF_VALIDATION`, `WF_CYCLE`)

5. **`packages/workflow/src/schema.ts`** — Zod schemas mirroring `types.ts`:
   - One exported function: `parseWorkflowDefinition(yamlText: string): WorkflowDefinition`
   - Use `yaml` package to parse, then Zod to validate
   - Beyond Zod, implement:
     - Cycle detection via DFS over `depends_on`
     - Validation that all `on_reject` IDs exist and are upstream of the gate
     - Validation that all `{{inputs.X}}` and `{{outputs.X}}` in prompts reference declared names
   - Throw `WorkflowValidationError` (or `WorkflowCycleError`) with clear, actionable messages including field paths and step IDs

6. **`packages/workflow/src/__tests__/schema.test.ts`** — at minimum 10 vitest tests covering:
   - Happy path: parses the feature-dev example from §3 of the design doc
   - Rejects: missing required fields, unknown step types
   - Rejects: cycles in `depends_on`
   - Rejects: `on_reject` pointing to non-existent step
   - Rejects: `on_reject` pointing to downstream step (must be upstream)
   - Rejects: template variable `{{inputs.X}}` not declared in inputs
   - Rejects: duplicate step IDs
   - Accepts: minimal workflow with just one step
   - Accepts: human_approval at end of chain
   - Loads a fixture file (create `__tests__/fixtures/valid-workflow.yaml`) and round-trips it

### Hard Constraints

- DO NOT modify any file outside `packages/workflow/`. If you think you need to, stop and explain why in a comment in the PR.
- DO NOT add the workflow package to `pnpm-workspace.yaml` if it's already covered by a glob pattern — check first. If not covered, ONLY add the glob entry (single line).
- Follow CLAUDE.md: no `any`, no `as any`, prefer `unknown` + narrowing.
- Match existing TypeScript style (look at `packages/cli/src/` for examples).
- Max 400 LOC per file (split if necessary).
- Add inline doc comments ONLY where the design doc's intent isn't obvious from the code.

### Acceptance — All Must Pass

```bash
pnpm install
pnpm --filter @aoagents/ao-workflow build
pnpm --filter @aoagents/ao-workflow typecheck
pnpm --filter @aoagents/ao-workflow test
pnpm typecheck   # whole repo
```

### When Done

1. Verify all acceptance commands pass locally.
2. Commit with conventional message: `feat(workflow): phase 0 — package foundation`
3. Push your branch.
4. Open a PR with `gh pr create --base feature/workflow-engine` (NOT main).
5. PR title: `feat(workflow): phase 0 — package foundation`
6. PR body should:
   - State that this is Phase 0 of the workflow-engine package
   - Link to `docs/workflow-engine.md` for full context
   - List the files added
   - Confirm all acceptance commands pass

### Out of Scope (do NOT touch)

- Engine, state store, artifact store, selectors, CLI, ao-client, completion-detector, approvals, prompt-template — these are later phases
- Any file outside `packages/workflow/` except possibly a single-line glob in `pnpm-workspace.yaml`
- Examples directory (later phase)
- README.md inside the package (later phase)

If you're tempted to deviate from this scope, stop and add a `// TODO(phase-X)` comment instead.
