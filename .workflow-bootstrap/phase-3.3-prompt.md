# Phase 3.3 — Prompt Contract Footer (Citation Rules in Every Agent Prompt)

## Required Reading

1. `docs/workflow-engine.md` — especially §16 (citation format) and **§17.3 (the exact footer text and decision rules you are about to encode)**. Read both end-to-end.
2. **Existing modules** (read before changing anything):
   - `packages/workflow/src/prompt-template.ts` — small file, two functions of interest: `appendExecutionContract` (which you are extending) and `prependFeedback` (which you are NOT touching). Note the visual style: `=== AOW <NAME> ===` block delimiters, numbered lists, blank lines for spacing.
   - `packages/workflow/src/__tests__/prompt-template.test.ts` — the test surface you are extending.
   - `packages/workflow/src/resolver/script.ts` — read this to confirm what flags the footer should tell the agent to pass (`--claim`, `--artifacts-dir`, `--workspace-path`, `--step-id`). The footer's example invocation must match the actual script's argv.
3. `CLAUDE.md` — repo conventions.

## What This PR Delivers

After 3.2, every spawned agent's worktree contains `.ao/aow-ref`, but the agent has no instructions to call it. This PR extends `appendExecutionContract` to append the §17.3 citation contract below the existing execution contract footer. From this PR on, every agent prompt rendered by the engine includes the citation rules.

**Important downstream effect**: the agent who implements Phase 3.4 (citation linter) is itself spawned under this footer. If the citation contract is unclear or inconsistent, the 3.4 agent's output will reveal the gaps. This is intentional dogfooding.

## Files to Modify

### 1. `packages/workflow/src/prompt-template.ts`

Extend `appendExecutionContract` so that after the existing `=== AOW EXECUTION CONTRACT === … === END CONTRACT ===` block, it appends a `=== AOW CITATION CONTRACT === … === END CITATION CONTRACT ===` block.

Keep the function signature the same:
```ts
export function appendExecutionContract(
  prompt: string,
  outputs: Record<string, string>,
): string
```

The combined output must:
1. Preserve the existing execution-contract behavior byte-for-byte (no whitespace drift, no numbering change).
2. Append the citation contract **once**, immediately after the execution contract, separated by a single blank line.
3. Always include the citation contract — even when `outputs` is empty (citations matter for any output the agent produces, declared or not).

The citation contract text MUST be a verbatim transcription of §17.3 of `docs/workflow-engine.md`, with two adjustments:

- Replace `node .ao/aow-ref "<file>#<section>"` etc. with the actual flags supported by the 3.1 script. The minimum invocation is:
  ```
  node .ao/aow-ref "<file>#<section>" \
    --artifacts-dir <abs path> \
    --workspace-path <abs path> \
    --step-id <step id>
  ```
  with `--claim "<claim>"` shown as an optional addition. The `<abs path>` and `<step id>` are placeholders the agent fills from context — explain that in one sentence inside the footer ("the engine sets these via environment variables when spawning your session" is **incorrect**; the agent must pass them explicitly because there is no env-var contract yet — see §17.6 out-of-scope). Be honest: tell the agent that `<artifacts-dir>` is the directory shown in its prompt's `{{inputs.<name>}}` and `{{outputs.<name>}}` paths' common parent.
- Drop any reference to MCP-native tools — they are out of scope per §17.6.

The rest of §17.3 (writing rules, reading rules, hop-depth limit, error handling, propagation) is reproduced verbatim. Do not paraphrase.

Implementation suggestion:
```ts
const CITATION_CONTRACT_FOOTER: string = [
  "=== AOW CITATION CONTRACT ===",
  // ... full §17.3 text, line by line, no template substitution needed
  "=== END CITATION CONTRACT ===",
].join("\n");

export function appendExecutionContract(
  prompt: string,
  outputs: Record<string, string>,
): string {
  // existing logic to build the execution-contract footer, unchanged
  // ...
  const separator = prompt.endsWith("\n") ? "" : "\n";
  return `${prompt}${separator}${executionFooter}\n\n${CITATION_CONTRACT_FOOTER}\n`;
}
```

The single trailing newline after the citation contract keeps the file POSIX-compliant if rendered to disk.

Stay under 400 LOC for `prompt-template.ts`. The citation contract text is ~70 lines; the whole file will end up around 200 LOC, well within budget.

### 2. `packages/workflow/src/__tests__/prompt-template.test.ts`

Add a `describe("citation contract", ...)` block with at least 5 tests:

1. **Preservation**: render a known prompt + outputs and assert the **existing** execution-contract section is still present, in the same position, with identical text. Use a string substring check against the pre-existing test's expected text — do NOT rewrite the old expectations.
2. **Citation contract present**: assert the rendered prompt contains the literal substrings:
   - `=== AOW CITATION CONTRACT ===`
   - `=== END CITATION CONTRACT ===`
   - `node .ao/aow-ref` (the resolver invocation example)
   - `hop_depth_4` (the hop-depth warning literal from §17.1)
   - `<!-- ref:` (the markdown citation format from §16)
   - `// ref:` (the code citation format from §16)
3. **Single instance**: assert each of `=== AOW CITATION CONTRACT ===` and `=== END CITATION CONTRACT ===` appears exactly once in the output (no duplicate appending).
4. **Order**: assert the citation contract appears AFTER the execution contract — find the index of `=== END CONTRACT ===` and assert the citation block starts at a later index.
5. **Empty outputs**: render with `outputs = {}` and assert the citation contract is still appended.

Update any **existing snapshot tests** that compare the rendered prompt against a full expected string — extend those expected strings to include the new citation contract block. Do not delete or weaken existing assertions.

### 3. `packages/workflow/src/index.ts`

No new exports needed — `appendExecutionContract` is already exported. Confirm by reading the file; if it isn't, add it.

## Hard Constraints

- Modify ONLY `packages/workflow/src/prompt-template.ts` and `packages/workflow/src/__tests__/prompt-template.test.ts`. Modify `index.ts` ONLY if `appendExecutionContract` is not already exported.
- DO NOT touch any other file. Specifically: no changes to `step-runner.ts`, `engine.ts`, `resolver/`, `citation-linter.ts` (doesn't exist yet — that's 3.4), or `cli.ts`.
- The citation contract text must be verbatim from §17.3 of `docs/workflow-engine.md` (with the two adjustments noted above). Do NOT add new instructions, soften the language, or "improve" the wording. The §17 spec is the source of truth.
- The function signature of `appendExecutionContract` does NOT change.
- DO NOT export the citation contract string as a constant. Keeping it internal means downstream callers can't fork it. The only public API change is behavioral (richer footer).
- Strict TS. No `any`.
- The function remains pure (no I/O).

## What "Verbatim" Means Here

Take §17.3 from `docs/workflow-engine.md`. Copy it. Paste it into the constant. The only changes you may make:

- Replace the `node .ao/aow-ref "<file>#<section>"` examples with versions that pass `--artifacts-dir`, `--workspace-path`, and `--step-id` (because the 3.1 script requires those flags).
- Remove any reference to "MCP-native resolver tool" — out of scope.
- Adjust whitespace **only** to match the existing footer style (4-space indents, blank-line separators between subsections).

Do NOT paraphrase. Do NOT add bullet points the spec doesn't have. Do NOT remove the §17.3 examples for §16's citation formats — the agent needs to see what a valid citation looks like, inline.

## Why It Has to Be Verbatim

The citation contract is the **contract between the engine and the agent**. If you paraphrase, you create drift between the spec and the runtime. When 3.4's linter rejects a citation, the failure feedback (via `prependFeedback`) refers the agent back to "the citation contract you were given" — that text must match the actual contract.

## Acceptance — All Must Pass

```bash
pnpm --filter @aoagents/ao-workflow build
pnpm --filter @aoagents/ao-workflow test    # all prompt-template tests pass, including new ones
pnpm typecheck                              # whole repo

# Manual smoke (paste in PR body):
node -e "
  import('./packages/workflow/dist/prompt-template.js').then(m => {
    console.log(m.appendExecutionContract(
      'Write a design doc covering authentication.',
      { design: '/abs/path/design.md' }
    ));
  });
"
```

## When Done

1. Verify all acceptance.
2. Commit: `feat(workflow): phase 3.3 — citation contract footer`
3. Push.
4. `gh pr create --base feature/workflow-engine --title 'feat(workflow): phase 3.3 — citation contract footer'`
5. PR body should include:
   - The full rendered prompt from the manual smoke (so reviewers can see the exact contract agents now receive)
   - Confirmation that all acceptance commands pass
   - A note: "From this PR forward, every agent step gets the citation contract. The Phase 3.4 implementer will be the first agent to operate under it — if anything in the contract reads ambiguously to that agent, file a follow-up issue."

## Out of Scope (DO NOT DO IN THIS PR)

- Citation linter — 3.4.
- `aow show --hops` — 3.5.
- Any change to the resolver script or its schema.
- Any change to `step-runner.ts`, `engine.ts`, `state-store.ts`, `cli.ts`, `completion-detector.ts`, `workspace-setup.ts`.
- New types (`Citation`, `HopRecord`, etc. were added in 3.1; do not re-define).
- Splitting `appendExecutionContract` into two functions — keep it one entry point.
- Any change outside `packages/workflow/`.
