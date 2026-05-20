# Phase 1b — Selectors + Prompt Template

## Required Reading

1. `docs/workflow-engine.md` — design spec. Read §6 (Selectors), §4 (Execution semantics — completion contract footer), §9 (Module Responsibilities — selectors + prompt-template). Skim the rest.
2. `packages/workflow/src/types.ts` — types already defined in Phase 0. Reuse, don't redefine. Note `Selector` and `SelectorKind`.
3. `packages/workflow/src/errors.ts` — extend with new error classes if needed.
4. `CLAUDE.md` — repo conventions.

## Files to Create

1. **`packages/workflow/src/selectors.ts`** — per §9:
   - One exported function: `resolveSelector(workflow: WorkflowDefinition, state: RunState, selector: Selector): { toRun: StepID[], warnings: string[] }`
   - Implement all 6 selector kinds per §6 resolution algorithm:
     - `all`: pending + stale + ready steps in topological order
     - `only`: returns [stepId] iff inputs (declared in step.inputs) are present on disk under artifacts_dir; else throw `MissingInputsError` with hint message
     - `from`: stepId and all transitively-reachable downstream steps in topo order
     - `to`: stepId and all transitive deps (upstream), in topo order
     - `through`: transitive deps of stepId that are NOT already completed, then stepId itself
     - `rerun`: mark stepId as pending in returned plan; cascade decision is caller's concern (warn in `warnings[]` if downstream is completed)
   - Topological sort: standard Kahn's algorithm over `depends_on`.
   - For `only`: check that ALL files in `step.inputs` exist; use `fs.access` (don't import artifact-store — keep selectors pure / testable without filesystem when possible — accept a `fileExists: (path: string) => Promise<boolean>` injectable for testing, default impl uses `fs/promises`).
   - Make `resolveSelector` async if `only` selector needs to check files. OK to have a sync helper for the others.

2. **`packages/workflow/src/prompt-template.ts`** — per §4 + §9:
   - `renderPrompt(template: string, vars: { inputs: Record<string, string>, outputs: Record<string, string> }): string` — Mustache-style `{{inputs.X}}` / `{{outputs.X}}` replacement. Implement minimal regex-based interpolation; do NOT pull in `mustache` or similar package.
   - `appendExecutionContract(prompt: string, outputs: Record<string, string>): string` — appends the footer from §4 listing the output files and "do not commit/push, stop when done."
   - `prependFeedback(prompt: string, feedback: string): string` — prepends prior-attempt feedback block per §4.
   - All three pure functions; no I/O.

3. **`packages/workflow/src/__tests__/selectors.test.ts`** — at least 10 vitest tests:
   - `all` returns topological order
   - `all` includes only pending/stale/ready (skips completed)
   - `only` returns [stepId] when inputs exist (mocked fileExists returns true)
   - `only` throws when inputs missing (mocked fileExists returns false), error message mentions step ID and missing path
   - `from` returns step + downstream in topo order
   - `to` returns step + upstream in topo order
   - `through` returns missing deps + step (skips already-completed upstream)
   - `rerun` includes stepId, emits cascade warning when downstream is completed
   - Disconnected components handled correctly
   - Single-step workflow handled correctly

4. **`packages/workflow/src/__tests__/prompt-template.test.ts`** — at least 6 vitest tests:
   - Renders `{{inputs.X}}` and `{{outputs.X}}` correctly
   - Leaves unknown placeholders alone (or throws — your call, document in code; recommend: throw `TemplateError` for unknown placeholders for safety)
   - Handles multiple occurrences of same placeholder
   - `appendExecutionContract` includes all declared output paths
   - `prependFeedback` includes the feedback text and a clear delimiter
   - Idempotency: renderPrompt on already-rendered output is a no-op

## Hard Constraints

- Modify ONLY `packages/workflow/`. Add the 4 files above plus minimal `errors.ts` additions (e.g., `MissingInputsError`, `TemplateError`, `CycleInSelectorResolutionError`).
- Do NOT modify `types.ts`, `schema.ts`, or anything from Phase 0 — types already cover this.
- No new dependencies. Implement template interpolation inline.
- All strict TS — no `any`.
- Max 400 LOC per file.

## Acceptance — All Must Pass

```bash
pnpm --filter @aoagents/ao-workflow build
pnpm --filter @aoagents/ao-workflow test
pnpm typecheck
```

## When Done

1. Verify all acceptance commands pass.
2. Commit: `feat(workflow): phase 1b — selectors + prompt-template`
3. Push your branch.
4. PR: `gh pr create --base feature/workflow-engine --title 'feat(workflow): phase 1b — selectors + prompt-template'`
5. PR body: files added, acceptance confirmation, note that this is independent of Phase 1a and 1c.

## Out of Scope

- Engine, artifact-store, state-store, ao-client, completion-detector, approvals, CLI — those are other phases.
- Examples, README — later.
- Any file outside `packages/workflow/`.
