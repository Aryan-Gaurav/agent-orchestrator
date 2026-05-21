# Phase 3.4 — Citation Linter + Step-Runner Integration (Hard Enforcement)

## Required Reading

1. `docs/workflow-engine.md` — **read end-to-end before designing**. Especially:
   - §16 (citation format — `<!-- ref: ... -->` vs `// ref: ...`, claim shape, single-hop rule)
   - §17.1 (resolver script contract — you invoke it as a subprocess for claim integrity checks)
   - §17.2 (post-step citation linter — **the exact contract this PR implements**)
   - §17.4 (failure-mode table — your tests must cover each row)
   - §17.6 (out of scope — do NOT add `must_cite:` schema, fuzzy slug matching, or cross-run refs)
2. **Existing modules** (read every one):
   - `packages/workflow/src/resolver/script.ts` and `schema.ts` — the resolver you call as a subprocess. Note its `--claim` flag, its exit code contract, and its `claim_match.confidence` field.
   - `packages/workflow/src/types.ts` — note `StepState` has no `warnings?` field yet; you add one.
   - `packages/workflow/src/state-store.ts` — note the `runStateSchema` Zod schema; you extend it to allow `warnings`.
   - `packages/workflow/src/engine/step-runner.ts` — `runAgentStep`'s completion path. You insert the linter call between `waitForStepCompletion` returning `"completed"` and the `updateStep(completed)` call.
   - `packages/workflow/src/approvals.ts` — note `readFeedback(runDir, stepId, attempt)`. The feedback file path convention is `feedback/{stepId}-attempt-{n}.md`. Your linter feedback file MUST follow the same convention, addressed at attempt `attempts + 1` (the NEXT attempt), so the existing retry path picks it up automatically.
   - `packages/workflow/src/prompt-template.ts` — `prependFeedback` is the function that consumes the feedback file content on the next attempt. You do NOT modify this; you just write a file in the right location.
   - `packages/workflow/src/artifact-store.ts` — `resolveArtifactPath` for any user-supplied paths.
   - `packages/workflow/src/errors.ts` — add two new error classes following the existing convention.
3. `CLAUDE.md` — repo conventions.

## What This PR Delivers

After 3.3, every agent prompt includes the citation contract. This PR adds the **enforcement** side: after an agent step's outputs exist and the agent goes idle, the engine lints every output for citation correctness. Errors reject the step (route through existing retry path with linter feedback prepended). Warnings persist to step state and surface on `aow show`.

This is the largest of the Phase 3 PRs (~350 LOC of new code + 200 LOC of tests). Stay disciplined: scope to §17.2, do not invent new YAML fields, do not add new retry primitives.

## Files to Create

### 1. `packages/workflow/src/citation-linter.ts`

The pure linter function. Single entry point:

```ts
export interface LintOptions {
  /** Outputs to lint, in the form ResolvedOutput uses in step-runner. */
  outputs: Array<{ name: string; absPath: string; relPath: string }>;
  /** Absolute path of the workflow's artifacts_dir. */
  artifactsDir: string;
  /** Absolute path of the agent's workspace (where .ao/ref-hops.jsonl lives). */
  workspacePath: string;
  /** Absolute path to dist/resolver/script.js, used for claim-integrity checks. */
  resolverScriptPath: string;
  /** The step's declared input count, used for the zero-citations-with-inputs warning. */
  trackedInputCount: number;
  /** Step ID, used for hop-depth aggregation from the workspace's ref-hops.jsonl. */
  stepId: string;
}

export interface LintError {
  outputName: string;
  outputPath: string;
  line: number;        // 1-based line of the offending citation, or 0 if file-level
  ref: string;
  kind:
    | "schema"
    | "file_not_found"
    | "section_not_found"
    | "claim_mismatch"
    | "outside_artifacts_dir";
  message: string;
}

export interface LintWarning {
  outputName: string;
  outputPath: string;
  kind:
    | "zero_citations_with_inputs"
    | "density_over_section"
    | "density_over_output"
    | "weak_claim_match"     // token_overlap with 0.7 <= confidence < 1.0
    | "hop_depth_exceeded";  // any chain > 4 hops in .ao/ref-hops.jsonl for this step
  message: string;
}

export interface LintReport {
  errors: LintError[];
  warnings: LintWarning[];
  /** Max hop depth observed for this step in .ao/ref-hops.jsonl. */
  maxHopDepth: number;
  /** Total citations parsed across all outputs. */
  citationCount: number;
}

export async function lintCitations(opts: LintOptions): Promise<LintReport>;
```

Implementation requirements:

**Citation parser**: Scan each output file for the two citation formats from §16:
- `<!-- ref: <file>#<section> claim="..." -->` (markdown HTML comment)
- `// ref: <file>#<section> claim="..."` (code/JSON/YAML single-line comment)

Parse both forms. The `claim="..."` part is optional in the format spec, but its absence triggers a warning (per §17.2 — "Citations without claims are warnings, not errors, in v1"). Track `line` (1-based) for each citation.

Acceptable file extensions for citation parsing: `.md`, `.markdown`, `.ts`, `.tsx`, `.js`, `.jsx`, `.json`, `.yaml`, `.yml`, `.py`, `.go`, `.rs`. Skip binary files. If an output's extension isn't in the list, scan for `<!-- ref:` (markdown comment) only — never crash on unknown extensions.

**Per-citation hard checks** (per §17.2):

For each parsed citation, call the resolver script as a subprocess:
```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

const { stdout } = await exec(process.execPath, [
  opts.resolverScriptPath,
  `${citation.file}${citation.section ? "#" + citation.section : ""}`,
  ...(citation.claim ? ["--claim", citation.claim] : []),
  "--artifacts-dir", opts.artifactsDir,
  "--workspace-path", opts.workspacePath,
  "--step-id", `${opts.stepId}-lint`,
]);
const parsed = parseResolverResponse(JSON.parse(stdout));
```

**Important**: pass `--step-id` as `${opts.stepId}-lint` so the linter's own hop-log entries don't poison the agent's hop counter. Hop-depth aggregation reads only entries whose `step_id` equals `opts.stepId` (not the `-lint` suffix).

If the resolver returns `ok: false`: produce a `LintError` of the matching `kind` (map `claim_mismatch` and `section_not_found` and `file_not_found` and `outside_artifacts_dir` directly; map any other error to `kind: "schema"` with a descriptive message).

If the resolver returns `ok: true` with `claim_match.match_kind === "token_overlap"` and `confidence < 0.7`: produce a `LintError` of kind `claim_mismatch` (per §17.2 tier policy: < 0.7 fails).

If the resolver returns `ok: true` with `claim_match.match_kind === "token_overlap"` and `0.7 <= confidence < 1.0`: produce a `LintWarning` of kind `weak_claim_match`.

If `match_kind` is `exact_substring` or `normalized_substring`: pass silently (no error, no warning).

**Per-output density checks** (soft — warnings only):

For each output file:
1. If the **step** declared >= 2 tracked inputs (`trackedInputCount >= 2`) AND the output has 0 citations: emit `zero_citations_with_inputs` warning. **Emit at most one such warning per output.**
2. Count `## H2` and `### H3` headings as `majorSections` (regex `/^#{2,3}\s+/m`). If `citations > 3 * Math.max(majorSections, 1)`: emit `density_over_output` warning.
3. For each `## H2` block, count citations inside that block. If a single block has > 3 citations: emit `density_over_section` warning (one per offending block).

**Hop-depth aggregation**:

Read `<workspacePath>/.ao/ref-hops.jsonl` (the agent's own hop log — NOT the `-lint` log you write during this lint). Filter entries where `step_id === opts.stepId`. Build chains by counting consecutive entries that share a logical traversal (for v1, treat the entire filtered list as one chain — every entry increments depth). Set `maxHopDepth` to the size of the filtered list. If > 4: emit one `hop_depth_exceeded` warning attributed to the FIRST output (no per-output meaning for hop depth, but warnings need an output for display).

Treat a missing hop log file as 0 hops, not an error.

**File reads**: every output path read in this module goes through `fs.access` first to verify existence; if missing, return an error report with an explanatory message (this should be impossible because `waitForStepCompletion` already verified existence, but defend against the race).

Keep the module under 400 LOC. If it grows past, split parser logic into `citation-linter/parser.ts` and density checks into `citation-linter/density.ts`. Keep the public entry point `lintCitations` in `citation-linter.ts`.

### 2. `packages/workflow/src/__tests__/citation-linter.test.ts`

At least 15 tests covering every row of §17.4's failure-mode table plus the density and tier-policy checks:

**Hard errors**:
1. File-not-found citation → `LintError { kind: "file_not_found" }`
2. Section-not-found citation → `LintError { kind: "section_not_found" }`
3. Claim mismatch (no tier matches) → `LintError { kind: "claim_mismatch" }`
4. Path-escape attempt (`../../../etc/passwd`) → `LintError { kind: "outside_artifacts_dir" }`
5. Token-overlap match with confidence < 0.7 → `LintError { kind: "claim_mismatch" }`
6. Schema-malformed ref (e.g. unbalanced quotes in the citation comment) → `LintError { kind: "schema" }`

**Passes (no errors, no warnings)**:
7. Exact-substring match → pass silently
8. Normalized-substring match → pass silently
9. Output with no citations and `trackedInputCount = 0` → no warnings

**Soft warnings**:
10. Zero citations + `trackedInputCount = 2` → one `zero_citations_with_inputs` warning
11. Token-overlap match with 0.7 <= confidence < 1.0 → one `weak_claim_match` warning
12. Output with 6 H2 sections and 25 citations → `density_over_output` warning (25 > 3 * 6 = 18)
13. Single H2 block with 5 citations → one `density_over_section` warning for that block
14. Hop log has 5 entries for `step_id` → one `hop_depth_exceeded` warning, `maxHopDepth === 5`
15. Hop log entries with `step_id` ending in `-lint` are NOT counted toward the depth check

**Cross-cutting**:
- Each test uses fixture files in `packages/workflow/src/__tests__/citation-linter/fixtures/`. Reuse the resolver fixtures from 3.1 where possible; add new ones for density-specific cases.
- The resolver script path is the built `dist/resolver/script.js`. Tests depend on `pnpm --filter @aoagents/ao-workflow build` having run first.

## Files to Modify

### 3. `packages/workflow/src/types.ts`

Add `warnings?: string[]` to `StepState`. Position it after `failure_reason`:

```ts
export interface StepState {
  status: StepStatus;
  attempts?: number;
  current_attempt?: AttemptRecord;
  history?: AttemptRecord[];
  awaiting_since?: string;
  failure_reason?: string;
  warnings?: string[];  // NEW — surfaces lint warnings (and future warnings)
}
```

Do NOT add any other fields. Do NOT change types added in 3.1. Do NOT pre-empt 3.5's `workspace_path` addition to `AttemptRecord` — that's a separate PR.

### 4. `packages/workflow/src/state-store.ts`

Extend the Zod schema for `StepState` so the new `warnings?: string[]` field is accepted and persisted. Make it `z.array(z.string()).optional()`. Verify the existing tests still pass.

### 5. `packages/workflow/src/engine/step-runner.ts`

In `runAgentStep`, in the `result.kind === "completed"` branch — **after** building `outputArtifacts` but **before** calling `updateStep(completed)` — insert the linter call:

```ts
// Lint citations before marking the step completed.
const workspacePath = await getSessionWorkspacePath(ctx.aoCtx, sessionId);
let lintReport: LintReport | null = null;
if (workspacePath) {
  try {
    lintReport = await lintCitations({
      outputs,
      artifactsDir: ctx.artifactsDir,
      workspacePath,
      resolverScriptPath: getBundledResolverScriptPath(),
      trackedInputCount: Object.keys(step.inputs ?? {}).length + (ctx.workflow.inputs?.length ?? 0),
      stepId: step.id,
    });
  } catch (err) {
    // Linter blew up — log and continue. Better to let the step pass than
    // crash the whole workflow on a linter bug. The escape valve.
    const reason = err instanceof Error ? err.message : String(err);
    log.warn(`[${step.id}] citation linter failed: ${reason}`);
  }
}

if (lintReport && lintReport.errors.length > 0) {
  // Hard fail: write feedback for the NEXT attempt and mark this attempt failed.
  const nextAttempt = attempts + 1;
  await writeLinterFeedback(ctx.runDir, step.id, nextAttempt, lintReport);
  await recordFailedAttempt(ctx, step, sessionId, branch, startedAt, inputs, outputArtifacts);
  await updateStep(ctx.runDir, step.id, (prev) => ({
    ...prev,
    failure_reason: "citations_invalid",
  }));
  return { kind: "failed", reason: "citations_invalid" };
}

// Soft warnings: persist to step state, proceed to mark completed.
const warningStrings = lintReport ? lintReport.warnings.map(formatWarning) : [];
```

Then update the existing `updateStep(completed)` call to include `warnings: warningStrings.length > 0 ? warningStrings : undefined` in the new state.

Add helper functions in the same file (or a sibling `engine/linter-feedback.ts` if `step-runner.ts` would exceed 400 LOC):

```ts
async function writeLinterFeedback(
  runDir: string,
  stepId: StepID,
  attempt: number,
  report: LintReport,
): Promise<void> {
  const lines: string[] = [];
  lines.push(`The previous attempt's outputs failed citation linting.`);
  lines.push(`Fix every error below before re-running. Refer to the citation contract in your prompt for the format.`);
  lines.push("");
  lines.push("Errors:");
  for (const e of report.errors) {
    lines.push(`- [${e.kind}] ${e.outputName} (line ${e.line}): ${e.ref} — ${e.message}`);
  }
  if (report.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings (not blocking, but address if relevant):");
    for (const w of report.warnings) {
      lines.push(`- [${w.kind}] ${w.outputName}: ${w.message}`);
    }
  }
  const feedbackPath = join(runDir, "feedback", `${stepId}-attempt-${attempt}.md`);
  await fs.mkdir(dirname(feedbackPath), { recursive: true });
  await fs.writeFile(feedbackPath, lines.join("\n") + "\n", "utf8");
}

function formatWarning(w: LintWarning): string {
  return `[${w.kind}] ${w.outputName}: ${w.message}`;
}
```

Add imports:
```ts
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { getSessionWorkspacePath } from "../ao-client.js";
import { getBundledResolverScriptPath } from "./workspace-setup.js";
import { lintCitations, type LintReport, type LintWarning } from "../citation-linter.js";
```

(`join` is likely already imported; don't double-import. `getSessionWorkspacePath` was added in 3.2.)

### 6. `packages/workflow/src/errors.ts`

Extend `WorkflowErrorCode` with `| "WF_CITATIONS_INVALID" | "WF_LINTER"`, and add two new classes at the end:

```ts
export class CitationsInvalidError extends WorkflowError {
  readonly stepId: string;
  readonly errorCount: number;

  constructor(stepId: string, errorCount: number, options?: ErrorOptions) {
    super(
      "WF_CITATIONS_INVALID",
      `Step "${stepId}" failed citation linting (${errorCount} error(s)). See feedback file for details.`,
      options,
    );
    this.name = "CitationsInvalidError";
    this.stepId = stepId;
    this.errorCount = errorCount;
  }
}

export class CitationLinterError extends WorkflowError {
  constructor(message: string, options?: ErrorOptions) {
    super("WF_LINTER", message, options);
    this.name = "CitationLinterError";
  }
}
```

`CitationsInvalidError` is for completeness; in this PR the step-runner returns `{ kind: "failed", reason: "citations_invalid" }` rather than throwing. The linter itself throws `CitationLinterError` on internal failures (parse crashes, resolver subprocess failures with unexpected exit codes).

### 7. `packages/workflow/src/index.ts`

Export `lintCitations`, the `LintReport`/`LintError`/`LintWarning` types, and the new error classes.

### 8. `packages/workflow/src/__tests__/engine.integration.test.ts`

Extend the existing integration test with TWO new scenarios:

**Scenario A — citation error triggers retry**:
- Mock agent writes an output with a deliberately broken citation (e.g. `<!-- ref: nonexistent.md#foo claim="x" -->`).
- Assert: first attempt is marked failed with `failure_reason: "citations_invalid"`, feedback file exists at `feedback/<stepId>-attempt-2.md` and contains the error description, no `current_attempt` carries the bad output (it moved to history).
- Then: simulate the user manually triggering a retry (or, more simply, run a second mocked attempt where the agent writes a clean output) and assert the step transitions to `completed` with `prependFeedback` content visible in the second-attempt prompt.

**Scenario B — warning-only path**:
- Mock agent writes an output with valid citations but high density (e.g. one H2 with 5 citations).
- Assert: step is `completed`, `state.steps[stepId].warnings` contains a `density_over_section` warning string.

Use temp dirs (`fs.mkdtemp`), clean up in `afterEach`. The integration test runs against `dist/resolver/script.js` — the test must depend on the package being built first.

## Hard Constraints

- Modify ONLY `packages/workflow/`. New files: `citation-linter.ts`, optional `engine/linter-feedback.ts`, test files, fixtures. Modify: `types.ts`, `errors.ts`, `state-store.ts`, `engine/step-runner.ts`, `index.ts`, `__tests__/engine.integration.test.ts`.
- DO NOT change the resolver script (3.1's domain) or `prompt-template.ts` (3.3's domain).
- DO NOT change `workspace-setup.ts` (3.2's domain) except to export `getBundledResolverScriptPath` if it isn't already exported.
- DO NOT add new YAML schema fields (`must_cite:`, `strict_citations:`, etc.) — explicitly out of scope per §17.6.
- DO NOT add a new retry primitive. Reuse the existing failed-attempt + feedback-file path so `prependFeedback` automatically picks up linter feedback on the next attempt.
- The linter itself never throws on bad citations — it returns a report. It only throws (`CitationLinterError`) on internal bugs (resolver subprocess crashed, file IO failed unexpectedly).
- The linter NEVER blocks marking a step `failed` for non-citation reasons (timeout, spawn failure). The linter only runs in the `result.kind === "completed"` branch of `runAgentStep`.
- Strict TS. No `any`. Max 400 LOC per file (split `citation-linter.ts` if needed).
- The resolver subprocess is invoked with `--step-id ${stepId}-lint` so it does NOT pollute the agent's hop counter.

## Why Reuse the Feedback-File Path

The retry loop already exists. `runAgentStep` reads `feedback/<stepId>-attempt-<n>.md` at the start of each attempt and calls `prependFeedback`. If we write the linter's report to that file path BEFORE returning `{ kind: "failed" }`, the engine's existing retry machinery picks it up on the next attempt with **zero new code paths**. This is the entire point of routing through the existing convention rather than inventing a new "linter-rejected" state.

## Acceptance — All Must Pass

```bash
pnpm --filter @aoagents/ao-workflow build
pnpm --filter @aoagents/ao-workflow test    # linter unit tests + extended integration tests
pnpm typecheck                              # whole repo
```

Plus a manual smoke (paste in PR body): construct a tiny fixture workflow with a bad citation, run `aow run`, observe the engine reject and write a feedback file.

## When Done

1. Verify all acceptance.
2. Commit: `feat(workflow): phase 3.4 — citation linter + step-runner integration`
3. Push.
4. `gh pr create --base feature/workflow-engine --title 'feat(workflow): phase 3.4 — citation linter + step-runner integration'`
5. PR body should:
   - List files added / modified with LOC counts (target: ~350 LOC of new src code + ~250 LOC of tests)
   - Confirm acceptance commands pass
   - Show the feedback-file output from one rejected step (so reviewers see what the agent will receive on retry)
   - State: "the `aow show --hops` flag is NOT in this PR — that's 3.5. Hop-depth warnings appear in step state but are not yet visible via CLI."

## Out of Scope (DO NOT DO IN THIS PR)

- `aow show --hops` flag — 3.5.
- `workspace_path` field on `AttemptRecord` — 3.5.
- Self-verification example workflow — 3.6 (deferred).
- Real-AO integration test — 3.5 (this PR's integration test still uses the mocked ao-client).
- Any YAML schema changes (e.g. per-step `strict_citations: true`) — §17.6 explicitly rejects these.
- Any change to `cli.ts`.
- Any change outside `packages/workflow/`.
