# Phase 3.5 — `aow show --hops` + Real-AO Integration Test

## Required Reading

1. `docs/workflow-engine.md` §17.1 (lines 1255–1403) — `.ao/ref-hops.jsonl` schema: each line is a JSON object with at minimum `ts`, `step_id`, `ref`, `outcome`, `match_kind`. The `aow show --hops` flag must render this trail per step.
2. `docs/workflow-engine.md` §17.2 (lines 1404–1461) — citation linter contract. Your integration test will deliberately violate it and assert recovery.
3. `docs/workflow-engine.md` line 699 and line 1374 — `aow show --hops` is explicitly named in the spec.
4. `packages/workflow/src/cli.ts` — current `show` command at line 199 (`showCmd`) and `ShowOpts` interface at line 195. You're adding ONE option, not rewriting.
5. `packages/workflow/src/citation-linter.ts` (merged in Phase 3.4) — the linter you're validating end-to-end.
6. `packages/workflow/src/engine/step-runner.ts` (merged in Phase 3.4) — where the linter is wired.
7. `packages/workflow/src/__tests__/engine.integration.test.ts` — the existing integration test template. Mirror its style.
8. `packages/workflow/src/resolver/script.ts` and `engine/workspace-setup.ts` — the resolver gets installed at `<workspacePath>/.ao/aow-ref`; tests run against the real script.
9. `CLAUDE.md` — repo conventions.

## Files to Modify

### 1. `packages/workflow/src/cli.ts` (MODIFY)

Extend `ShowOpts` with one new field:

```ts
interface ShowOpts extends GlobalOpts {
  step?: StepID;
  hops?: boolean;
}
```

In `showCmd`, after the existing `--step` branch but before `emitResult("show", ...)`, handle `opts.hops`:

- For each step in `state.steps`, locate its workspace path. Reuse `getSessionWorkspacePath` from `ao-client.ts` if the step has a session ID; otherwise skip with a `(no workspace)` placeholder.
- Read `<workspacePath>/.ao/ref-hops.jsonl` if it exists. Each line is JSON; skip blank lines and lines that fail to parse (record one warning to stderr, don't throw).
- Group entries by `step_id` (the JSON field, NOT the step ID from state — they should match, but tolerate divergence).
- Format the trail per step:
  ```
  Step: <step-id>  (workspace: <relative-path>)
    1. <ref>  →  <outcome>  (match: <match_kind>)
    2. <ref>  →  <outcome>  (match: <match_kind>)
       ...
  ```
- If `--hops` is combined with `--step <id>`, scope output to that step only.
- If no `.ao/ref-hops.jsonl` exists anywhere → emit a single line `"No hop records found."` and return.

Emit the entire formatted trail via `emitResult("show-hops", { run_id: runId, hops_by_step: {...} })` so `--json` mode still works. The plain-text formatting is rendered by `emitResult` when `--json` is off — mirror how `emitResult` already handles object vs. string results in this file.

In the command registration block (around line 350), add `.option("--hops", "show citation hop trails per step")`.

**Do not change:** the existing `show` behavior when `--hops` is absent. The existing `--step` behavior is unchanged unless `--hops` is also passed.

### 2. `packages/workflow/src/__tests__/integration/citation-recovery.integration.test.ts` (NEW)

Use vitest. Real filesystem, real subprocess execution. Mock the AO context the way `engine.integration.test.ts` already does — DO NOT spawn real Claude agents; mock the agent response to control output content.

The test must:

1. **Build a fixture workflow** in a tmp dir:
   - One `workflow.yaml` with two steps: `design` (produces `design.md`) and `impl` (consumes `design.md`, produces `impl.md`).
   - The `design` step's mocked agent output is a file `design.md` with two clean `## Section A` / `## Section B` headings.
   - The `impl` step's mocked agent FIRST attempt produces `impl.md` with a deliberately bad citation: `<!-- ref: design.md#missing-section claim="X" -->`.
   - The `impl` step's mocked agent SECOND attempt (after rejection) produces `impl.md` with a valid citation: `<!-- ref: design.md#section-a claim="..." -->` matching real content.

2. **Run the engine** end-to-end via the existing `runWorkflow` entry point. The engine should:
   - Complete `design` step cleanly.
   - Reject `impl` step on first attempt (linter raises `section_not_found` error).
   - Pass `impl` step on second attempt (with `prependFeedback`'d retry).

3. **Assertions:**
   - First attempt's step state has `failure_reason: "citations_invalid"`.
   - Linter feedback in the retry prompt contains the literal `section_not_found`.
   - Second attempt completes with `status: "completed"`.
   - `.ao/ref-hops.jsonl` was written during both attempts.

4. **`aow show --hops` smoke test:** programmatically invoke `showCmd(runId, { hops: true })` against the completed run and assert the captured stdout contains both attempts' refs.

Total: ~150 LOC. If you exceed 250, refactor — likely too much fixture scaffolding.

### 3. CLI help / docs (MODIFY in same `cli.ts`)

The Commander `.option("--hops", "...")` registration above IS the help text. One sentence, ≤80 chars: `"show citation hop trails per step (reads .ao/ref-hops.jsonl)"`. No separate doc file.

## Hard Constraints

- Modify ONLY: `packages/workflow/src/cli.ts` and the new test file (plus its fixture dir if needed). Nothing else — no changes to `engine.ts`, `step-runner.ts`, `citation-linter.ts`, `resolver/*`, `types.ts`, or any plugin.
- Strict TS, no `any`. Narrow JSON via small inline type guards if needed; do not introduce a new schema file.
- No new top-level dependencies.
- Per-file LOC cap: 400 (hard). `cli.ts` is currently around 360 lines — if your additions push it over 400, extract the hop-rendering helper into a tiny `cli/render-hops.ts` (≤80 LOC). Do not bloat `cli.ts`.
- Integration test must run via `pnpm --filter @aoagents/ao-workflow test` — no `test:integration` filter needed. If `vitest.config.ts` already excludes `__tests__/integration/`, INCLUDE it explicitly via a config update — flag this in the PR notes.

## Acceptance (run and paste outputs in PR body)

```bash
pnpm --filter @aoagents/ao-workflow build
pnpm --filter @aoagents/ao-workflow test
pnpm --filter @aoagents/ao-workflow typecheck
```

All must pass. Total test count must increase by at least 1 (the new integration test, which may internally have multiple assertions but counts as one test or a small block).

Also paste the output of:
```bash
node packages/workflow/dist/cli.js show <some-run-id> --hops
```
against a fixture run created during the test, to demonstrate the CLI output format. A short JSON-mode example too.

## When Done

1. Branch off `feature/workflow-engine`. Push and open PR with `gh pr create --base feature/workflow-engine`.
2. PR title: `feat(workflow): phase 3.5 — aow show --hops + citation recovery integration test`
3. PR body — match PR #6 (Phase 3.1) format:
   - Summary (2–3 sentences: what the flag shows, what the integration test proves)
   - Files Added (the integration test)
   - Files Modified (cli.ts, possibly vitest.config.ts)
   - Acceptance (the three command outputs + the demo `--hops` output)
   - Notes (any non-obvious choice — e.g., why mocking the agent in the integration test rather than running real Claude)
   - Test plan checklist

## Out of Scope

- Adding `--hops-min-depth` or any threshold/filter flags. v1 prints everything.
- Real Claude-code subprocess invocation in the integration test (use mocked agent context).
- Any change to the linter, resolver, or step-runner — those are merged and frozen.
- A separate `aow hops` top-level subcommand. The flag lives on `show`.
- Phase 3.6 / self-verification workflow.
