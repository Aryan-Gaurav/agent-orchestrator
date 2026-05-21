# Phase 3.3 — Citation Contract Prompt Footer

## Required Reading

1. `docs/workflow-engine.md` §17.3 (Prompt Contract Additions) — **the verbatim footer text you must append is in this section**. Also skim §17.1 (resolver script) and §17.2 (linter) for context on what the footer is teaching agents about.
2. `packages/workflow/src/prompt-template.ts` — the file you are modifying. Note `appendExecutionContract` at line 55 and its existing footer block at lines 64–73.
3. `packages/workflow/src/__tests__/prompt-template.test.ts` — extend, do not rewrite.
4. `CLAUDE.md` — repo conventions.

## File to Modify

**`packages/workflow/src/prompt-template.ts`**

Add a single new top-level `const` near the top of the file (after the imports / above `renderPrompt`):

```ts
const CITATION_CONTRACT_FOOTER = `
=== CITATION CONTRACT ===
<VERBATIM TEXT FROM docs/workflow-engine.md §17.3, lines 1471–1531>
=== END CITATION CONTRACT ===
`;
```

**Copy the contract text exactly from §17.3 — character-for-character including blank lines and the leading `=== CITATION CONTRACT ===` / trailing `=== END CITATION CONTRACT ===` lines.** Do not paraphrase. The spec text is the contract.

Then modify `appendExecutionContract` (signature unchanged) so that after the existing `=== END CONTRACT ===` footer it also appends the citation contract footer. One blank line of separation between the two blocks.

Do not change:
- The function signature
- The behavior of `renderPrompt` or `prependFeedback`
- Anything else in the file beyond what's required for the addition

## File to Modify (Tests)

**`packages/workflow/src/__tests__/prompt-template.test.ts`**

Add ONE new test case to the `appendExecutionContract` describe block. The test must assert:

1. The rendered prompt contains the literal string `=== CITATION CONTRACT ===`
2. The rendered prompt contains the literal string `=== END CITATION CONTRACT ===`
3. The rendered prompt contains all four load-bearing fragments:
   - `node .ao/aow-ref`
   - `hop_depth_4`
   - `claim_mismatch`
   - `ONE HOP BACK`
4. The citation block appears AFTER `=== END CONTRACT ===` (use `indexOf` comparison)
5. The existing "preserves the original prompt content verbatim" test must still pass — do not modify it.

Use the existing test setup pattern. Do not introduce new test utilities.

## Hard Constraints

- Modify ONLY `packages/workflow/src/prompt-template.ts` and `packages/workflow/src/__tests__/prompt-template.test.ts`. Nothing else — not `types.ts`, not `errors.ts`, not the index, nothing.
- Do not export the new `CITATION_CONTRACT_FOOTER` const. It's internal.
- Strict TS, no `any`.
- The change is a PURE STRING ADDITION. No imports, no I/O, no new dependencies.
- Per-file LOC cap: 400. The current file is well under; stay there.
- Match existing code style (semicolons, double quotes for strings or template literals, etc. — match what's already in the file).

## Acceptance (run these and paste outputs in PR body)

```bash
pnpm --filter @aoagents/ao-workflow build
pnpm --filter @aoagents/ao-workflow test
pnpm --filter @aoagents/ao-workflow typecheck
```

All three must succeed. Test count must be: prior count + 1 (one new assertion case).

## When Done

1. Commit on a new branch off `feature/workflow-engine` named like `session/<your-session-id>` or `workflow/phase-3.3-citation-footer`.
2. Push and open a PR with `gh pr create --base feature/workflow-engine`.
3. PR title: `feat(workflow): phase 3.3 — append §17.3 citation contract footer`
4. PR body — match the format of PR #6 (Phase 3.1) exactly:
   - Summary (2–3 sentences)
   - Files Added (none)
   - Files Modified (2 bullets)
   - Acceptance (the three command outputs)
   - Notes (1–2 short bullets, optional)
   - Test plan checklist

## Out of Scope

- Phase 3.4 (citation linter) — that is a separate PR, separate session.
- Phase 3.5 (hops CLI) — same.
- Any change to `renderPrompt`, `prependFeedback`, schema files, types, or engine code.
- Wiring the resolver into the engine. The contract footer is INFORMATIONAL — agents read it; nothing in this PR enforces it.
- Refactoring `appendExecutionContract` into helper functions. Keep it inline.
