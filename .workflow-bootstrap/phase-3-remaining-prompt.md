# Phase 3 — Remaining Sub-Phases (3.3, 3.4, 3.5)

You are implementing the remainder of Phase 3 (reference resolution + bloat
control, §16 + §17 of `docs/workflow-engine.md`) for the AO Workflow Engine.

**Phases 3.1 and 3.2 are already merged.** Pull `feature/workflow-engine` and
look at what's there before doing anything else:
- `packages/workflow/src/resolver/script.ts` + `resolver/schema.ts` (3.1)
- `packages/workflow/src/engine/workspace-setup.ts` (3.2 — installs `.ao/aow-ref`
  into agent worktrees)
- `packages/workflow/src/types.ts` exports `Citation`, `HopRecord`,
  `ResolverResponse`, etc.

## Required reading (in this order)

1. `docs/workflow-engine.md` §16 (reference preservation) and §17 (resolver +
   linter + hops + 4-hop warning). Read in full — every detail in §17 is a
   contract.
2. `CLAUDE.md` and `AGENTS.md` at repo root for code conventions.
3. `.workflow-bootstrap/phase-3-progress.md` for where we are.
4. The merged code listed above.

## What you are building (three PRs, in order)

You will open **three separate PRs** against `feature/workflow-engine`. Each
PR is self-contained: tests pass, typecheck clean, only `packages/workflow/`
touched. Wait for the human to merge each before starting the next.

### Step 3.3 — Prompt contract footer (~30 LOC + tests)

Extend `appendExecutionContract` in `packages/workflow/src/prompt-template.ts`
with the §17.3 citation contract footer. Every rendered prompt should now
instruct the agent how and when to cite, and to call `./.ao/aow-ref` to verify
its own citations. Update `prompt-template.test.ts` to assert the footer is
appended.

Acceptance:
- `pnpm --filter @aoagents/ao-workflow build`
- `pnpm --filter @aoagents/ao-workflow test`
- `pnpm typecheck`

### Step 3.4 — Citation linter + step-runner integration (~350 LOC + tests)

Create `packages/workflow/src/citation-linter.ts`: a pure function that takes
a step's output file paths + config and returns `{ errors: [...], warnings:
[...] }`. Errors cover malformed/dangling refs and (when the resolver returns
`claim_mismatch`) fabricated claims. Warnings cover density and hop-depth >4
(read `.ao/ref-hops.jsonl`).

Wire it into `packages/workflow/src/engine/step-runner.ts` between
"outputs exist" (completion-detector) and "mark completed". On errors,
mark the step failed with reason `citations_invalid` and feed the errors
back to the agent via `prependFeedback` from `prompt-template.ts`.

Call the resolver via subprocess (`.ao/aow-ref`) for claim integrity. Reuse
`artifact-store.ts` for file reads and path safety. Reuse `errors.ts` —
add `CitationError` if needed.

Tests: fixture artifacts with good/bad citations, density edge cases,
tier policy, hop-depth aggregation, all 5 resolver error kinds. Plus a
step-runner integration test showing rejection + retry-via-feedback works.

Acceptance: same three commands as 3.3.

### Step 3.5 — `aow show --hops` + real-AO integration test (~150 LOC + tests)

Extend `packages/workflow/src/cli.ts`: add a `--hops` flag to the `show`
command. Read `.ao/ref-hops.jsonl` for each step in the run and format the
hop trail (step → file → section → outgoing refs, indented).

Write a real-AO integration test (under `__tests__/integration/`) that runs
`aow run` against a fixture workflow with deliberate citation errors and
asserts the linter rejects the step and the agent recovers on the retry.

Document `aow show --hops` in CLI help text.

Acceptance: same three commands.

## Hard rules

- **Branch base for every PR: `feature/workflow-engine`.** Never target `main`.
- **Modify only `packages/workflow/`.** Do not touch `packages/core`, `packages/cli`,
  `packages/web`, or any other plugin. If a change you want requires touching
  one of those, STOP and ask the human.
- **Strictly sequential.** Do not start 3.4 until 3.3 is merged. Do not start
  3.5 until 3.4 is merged. The Zod exports of each phase feed the next.
- **Per-file LOC cap: 400.** 3.1's resolver/script.ts overran to 446 — do not
  repeat that. Split into helper modules if a file approaches the cap.
- **TS strict, no `any`.** Match the style of prior phases.
- **PR description format:** match PR #6 (Phase 3.1). Sections: Summary,
  Files Added, Files Modified, Acceptance (with command outputs), Notes,
  Test plan checklist.
- **Update `.workflow-bootstrap/phase-3-progress.md`** with a one-line entry
  after each PR opens and after each PR merges (the human will tell you
  when merged via `ao send`).

## When done

After all three PRs are merged, append:
```
[<ISO timestamp>] phase=3 event=complete note=3.3+3.4+3.5 merged; Phase 3 done
```
to `phase-3-progress.md`, commit + push, and `ao report completed`.

## Reviewer-in-the-loop

The human is using `ao review run <your-session>` to spawn a reviewer agent
on each PR you open. You will receive review findings via `ao send` — treat
those messages as work to address: read the findings, fix the code, push
updates to the same PR branch.

## Out of scope

- The optional "Phase 3.6 self-verification workflow" (a fixture workflow that
  tests Phase 3 against itself). Skip it unless the human asks.
- The deferred Phase 3.1 cleanup (resolver/script.ts LOC overrun). Don't fold
  it in — separate concern.
- Any prompt-file scaffolding (`.workflow-bootstrap/phase-3.N-prompt.md`).
  That pattern is retired; you derive scope from spec + merged code.
