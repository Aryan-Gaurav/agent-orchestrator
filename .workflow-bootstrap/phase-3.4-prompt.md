# Phase 3.4 — Citation Linter + Step-Runner Integration

## Required Reading

1. `docs/workflow-engine.md` §17.2 (Post-Step Citation Linter, lines 1404–1461) — the contract you're implementing. Hard checks vs soft warnings, tier policy, integration timing.
2. `docs/workflow-engine.md` §17.1 (Resolver Script, lines 1255–1403) — the resolver subprocess you'll invoke. Note the JSON response shape and the 5 error kinds.
3. `docs/workflow-engine.md` §17.3 (Prompt Contract, lines 1462–1538) — the citation comment formats agents emit. **Markdown: `<!-- ref: <file>#<section> claim="..." -->` ; code/JSON: `// ref: <file>#<section> claim="..."`**. Lifted forward; the linter parses both.
4. `packages/workflow/src/engine/step-runner.ts` — the file you wire into. `runAgentStep` at line 51, see the flow: `setupWorkspace` → `spawnAgentSession` → `waitForStepCompletion` → outputs verified → return. **You insert the linter call AFTER outputs are verified and BEFORE returning success.**
5. `packages/workflow/src/resolver/script.ts` and `resolver/schema.ts` — the resolver. Note: invoke via `node <bundled-path> "<ref>" --claim "..." --artifacts-dir ... --workspace-path ... --step-id ...`. Use `parseResolverResponse` from `resolver/schema.ts` to validate the JSON.
6. `packages/workflow/src/prompt-template.ts` — `prependFeedback` at line 81. You'll use this for the rejection path.
7. `packages/workflow/src/errors.ts` — add a new `CitationError` class following the existing pattern.
8. `packages/workflow/src/types.ts` — re-use `Citation`, `HopRecord` if already present; otherwise add types here. Do not redefine.
9. `packages/workflow/src/artifact-store.ts` — use `resolveArtifactPath` for path safety; do not re-implement.
10. `CLAUDE.md` — repo conventions.

## Files to Create

### 1. `packages/workflow/src/citation-linter.ts` (NEW — main module)

Public surface (exact signatures):

```ts
export interface CitationFinding {
  kind: "error" | "warning";
  code: CitationFindingCode;
  outputFile: string;          // relative to artifactsDir
  ref?: string;                 // the ref string if applicable
  claim?: string;
  message: string;              // human-readable, what went wrong
  detail?: string;              // expected vs found, extra context
}

export type CitationFindingCode =
  | "malformed_ref"
  | "file_not_found"
  | "section_not_found"
  | "outside_artifacts_dir"
  | "claim_mismatch"
  | "claim_low_confidence"       // token_overlap < 0.7 (hard fail)
  | "missing_claim"              // citation has no claim="..." (warning)
  | "no_citations_but_inputs"    // step has ≥2 tracked inputs, output has 0 citations
  | "over_citation"              // > 3*major_sections citations
  | "section_over_cited"         // single ### block has > 3 citations
  | "hop_depth_exceeded";        // any step invocation > 4 hops

export interface LintInputs {
  artifactsDir: string;          // absolute
  workspacePath: string;         // absolute, where .ao/ref-hops.jsonl lives
  stepId: string;
  outputFiles: string[];         // absolute paths to lint
  trackedInputCount: number;     // for density check
  resolverScriptPath: string;    // absolute path to bundled resolver
}

export interface LintReport {
  errors: CitationFinding[];
  warnings: CitationFinding[];
}

export async function lintStepCitations(input: LintInputs): Promise<LintReport>;
```

**Implementation rules — follow exactly:**

1. **Citation extraction.** For each output file, read content. Extract citations using these two regexes (order matters — try HTML first, then line-comment fallback):
   - `/<!--\s*ref:\s*([^#\s]+)#([^\s"]+)(?:\s+claim="([^"]*)")?\s*-->/g`
   - `/(?:\/\/|#)\s*ref:\s*([^#\s]+)#([^\s"]+)(?:\s+claim="([^"]*)")?/g`
   For each match, record `{ refString, file, section, claim, outputFile, lineNumber }`.

2. **Per-citation hard checks (run in this order, stop on first failure for that citation):**
   - a. Resolve the file path under `artifactsDir` via `resolveArtifactPath`. On throw → emit `outside_artifacts_dir` error.
   - b. Invoke the resolver subprocess: `node <resolverScriptPath> "<refString>"` (omit `--claim` for the existence check). Pass `--artifacts-dir`, `--workspace-path`, `--step-id`. Use `child_process.execFile` with a 15s timeout. Parse stdout via `parseResolverResponse`.
   - c. If resolver returns `ok=false` with `error: "file_not_found"` → `file_not_found` error. Same mapping for `section_not_found`, `malformed_ref`, `outside_artifacts_dir`.
   - d. If the citation has a `claim`, invoke resolver again with `--claim "<claim>"`. Apply §17.2 tier policy:
     - response.claim_match.match_kind === `"exact_substring"` or `"normalized_substring"` → silent pass
     - `"token_overlap"` with confidence ≥ 0.7 → emit `claim_low_confidence` as WARNING (not error)
     - `"token_overlap"` with confidence < 0.7 → emit `claim_low_confidence` as ERROR
     - resolver returned `error: "claim_mismatch"` → emit `claim_mismatch` ERROR
   - e. If the citation has NO claim → emit `missing_claim` as WARNING.

3. **Per-output density checks (warnings only):**
   - `trackedInputCount >= 2` AND citations.length === 0 → `no_citations_but_inputs`
   - Count `### ` lines in the output (major sections). If `citations.length > 3 * majorSections` (and majorSections > 0) → `over_citation`
   - For each `### ` block, count citations inside it. If > 3 → `section_over_cited` (one finding per offending block, with `detail` naming the section).

4. **Cross-step hop-depth aggregation:**
   - Read `{workspacePath}/.ao/ref-hops.jsonl` if it exists. Each line is a JSON object with at minimum `step_id` and `ref`.
   - Group by `step_id`. If `stepId` (input) has more than 4 entries in the log → emit `hop_depth_exceeded` WARNING. (Cap one finding per step, not per hop.)
   - File missing → no warning, no error.

5. **Subprocess discipline.**
   - Use `child_process.execFile` — never `exec` (no shell). Args array, not a string.
   - 15s timeout per invocation. On timeout → emit `file_not_found` error with `detail: "resolver timeout"`. (Conservative: treat as if the file couldn't be checked.)
   - Resolver may print warnings/noise to stderr; only parse stdout.
   - Run resolver invocations sequentially within a single output, but you MAY parallelize across output files via `Promise.all` if it stays simple.

6. **Return:** populated `LintReport`. Empty arrays if nothing fired. Caller decides what to do.

**File budget: ≤ 300 LOC.** If you approach 300, split helpers into a private module (e.g., `citation-linter/extract.ts`) — do not bloat one file.

### 2. `packages/workflow/src/__tests__/citation-linter.test.ts` (NEW)

Use vitest. Real filesystem fixtures under `__tests__/citation-linter/fixtures/` (mirror the resolver test layout). Spawn the actual resolver script as subprocess — DO NOT mock subprocess calls, this is an integration check.

Minimum 12 tests:

1. Clean output, no citations → empty errors + warnings
2. Output with one valid `<!-- ref: ... claim="..." -->` whose claim matches exactly → no findings
3. Markdown comment AND `// ref:` line comment both parsed in one file
4. `claim="..."` missing → `missing_claim` warning, not error
5. Bad file ref → `file_not_found` error
6. Bad section ref → `section_not_found` error
7. Malformed ref string (`#section-only`) → `malformed_ref` error
8. Path escape (`../escape.md#x`) → `outside_artifacts_dir` error
9. Resolver returns `token_overlap` with confidence 0.8 → `claim_low_confidence` WARNING
10. Resolver returns `claim_mismatch` (or token_overlap < 0.7) → ERROR
11. Density: 2 tracked inputs, 0 citations → `no_citations_but_inputs` warning
12. Hop log with 5 entries for the step → `hop_depth_exceeded` warning
13. Hop log missing → no hop-depth finding
14. Resolver subprocess timeout (mock by pointing at a script that sleeps) → finding with `detail: "resolver timeout"`

Fixtures: at least one `design.md` with 3+ slug-able sections, one bad/escaping ref file, and a known-good output file.

### 3. `packages/workflow/src/engine/step-runner.ts` (MODIFY)

In `runAgentStep`, AFTER outputs are verified (existence + hash) and BEFORE returning success:

1. Build `LintInputs`. The resolver script path comes from the same bundled location `workspace-setup.ts` uses — extract that into a shared helper if needed (e.g., a new tiny `engine/resolver-path.ts` with `getBundledResolverScriptPath`).
2. Compute `trackedInputCount` from the step's declared inputs (count them — every entry in the step's `inputs[]`).
3. Call `lintStepCitations`.
4. If `report.errors.length > 0`:
   - Mark the step `failed` with `failure_reason: "citations_invalid"`.
   - Format a feedback message: each error as `"- [<code>] <outputFile>:<ref> — <message>"`. Include warnings in a separate `Warnings (non-blocking):` section.
   - Attach the formatted feedback via `prependFeedback` to the step's next-attempt prompt (the engine already wires this on retry).
   - Return the existing `failed` outcome shape with the new reason.
5. If only warnings: attach to step state (extend the existing step state shape if needed — minimal: a `warnings: string[]` field) and proceed to mark `completed`.
6. If both empty: proceed to mark `completed` as today.

Do not change `runApprovalStep`. Do not change `setupWorkspace`, the spawn path, or any timing.

**Hard constraint:** keep `step-runner.ts` ≤ 400 LOC after changes. Current is 280; you have headroom but stay disciplined. If it grows past 380, extract the linter wiring into a tiny `engine/lint-step.ts`.

### 4. `packages/workflow/src/errors.ts` (MODIFY)

Add:

```ts
export class CitationError extends WorkflowError {
  readonly code = "WF_CITATION";
  constructor(message: string, options?: { cause?: unknown }) { super(message, options); }
}
```

Add `"WF_CITATION"` to the `WorkflowErrorCode` union. Match the existing style.

### 5. `packages/workflow/src/index.ts` (MODIFY)

Export `lintStepCitations`, `CitationFinding`, `CitationFindingCode`, `LintInputs`, `LintReport`, `CitationError`. Nothing more.

## Hard Constraints

- Modify ONLY: the 5 files listed above plus the new fixtures directory. Nothing else.
- Strict TS, no `any`. Use `unknown` + narrowing.
- No new top-level dependencies.
- Per-file LOC cap: 400. The linter itself targets ≤ 300.
- Subprocess timeout 15s, no exceptions.
- Density warning thresholds are constants at the top of `citation-linter.ts` (e.g., `MAX_CITATIONS_PER_SECTION = 3`, `MAX_CITATION_DENSITY_MULTIPLIER = 3`, `HOP_DEPTH_LIMIT = 4`). Named, not magic numbers.

## Acceptance (run and paste outputs in PR body)

```bash
pnpm --filter @aoagents/ao-workflow build
pnpm --filter @aoagents/ao-workflow test
pnpm --filter @aoagents/ao-workflow typecheck
```

All must pass. Test count must increase by ≥ 12.

## When Done

1. Branch off `feature/workflow-engine`. Push and open PR with `gh pr create --base feature/workflow-engine`.
2. PR title: `feat(workflow): phase 3.4 — citation linter + step-runner integration`
3. PR body — match PR #6 (Phase 3.1) format:
   - Summary (3–4 sentences: what it does, where it's wired, what it rejects vs warns)
   - Files Added (linter, tests, fixtures)
   - Files Modified (step-runner, errors, index)
   - Acceptance (the three command outputs)
   - Notes (any non-obvious tradeoffs; e.g., why subprocess vs in-process resolver call)
   - Test plan checklist

## Out of Scope

- Phase 3.5 (`aow show --hops` + real-AO integration test). Separate PR, separate session.
- Changing the resolver script (Phase 3.1). The resolver's behavior is the contract; if you find a bug in it, FLAG IT in the PR description but do not fix it here.
- Changing `appendExecutionContract` or the §17.3 footer (Phase 3.3, already merged).
- Adding a `--strict-citations` flag or per-step opt-out. Citations are on for every step in v1.
- Refactoring the step-runner's overall flow. Insert the linter call cleanly; do not restructure.
