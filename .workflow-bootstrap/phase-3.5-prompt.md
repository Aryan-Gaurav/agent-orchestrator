# Phase 3.5 — `aow show --hops` + Real-AO Integration Test (Phase 3 Capstone)

## Required Reading

1. `docs/workflow-engine.md` — especially:
   - §17.5 (`aow show --hops` contract — the exact format you're emitting)
   - §17.1 (the `.ao/ref-hops.jsonl` line shape — `step_id`, `ref`, `outcome`, `match_kind`)
   - §17.6 (out of scope — no telemetry, no per-step config)
2. **Existing modules** (read every one):
   - `packages/workflow/src/cli.ts` — find the `show` command. Note its existing `--step` and `--json` flags. You add `--hops`. Note the table-rendering pattern (`chalk` colors, manual column padding — no external table library).
   - `packages/workflow/src/types.ts` — note `AttemptRecord` has no `workspace_path` field. You add one (optional).
   - `packages/workflow/src/state-store.ts` — extend the Zod schema for `AttemptRecord` to permit the new field.
   - `packages/workflow/src/engine/step-runner.ts` — find every place `AttemptRecord` is constructed (`recordFailedAttempt`, `recordSucceededAttempt` if it exists, the inline records in `runAgentStep`). Each must capture `workspace_path` if available.
   - `packages/workflow/src/ao-client.ts` — `getSessionWorkspacePath(ctx, sessionId)` was added in 3.2. Reuse it.
   - `packages/workflow/src/__tests__/engine.integration.test.ts` — the mocked-engine test you extend (do not delete).
3. `CLAUDE.md` — repo conventions.

## What This PR Delivers

After 3.4, the engine enforces citations and persists warnings to step state. But the only way to see hop trails is to `cat .ao/ref-hops.jsonl` inside each worktree. This PR adds the operator-facing visibility: `aow show --hops <runId>` prints a per-step hop trail with outcome and match-kind classification. The PR also adds a real-AO end-to-end integration test that runs an actual workflow against a real `ao-core` SessionManager (no mocks) and verifies the citation linter rejects an attempt and accepts a corrected retry.

This is the smallest of the Phase 3 PRs in terms of new feature surface (~150 LOC for the CLI work), but the integration test is meaty (~200 LOC) and is the capstone proving Phase 3 works end-to-end.

## Files to Modify

### 1. `packages/workflow/src/types.ts`

Add `workspace_path?: string` to `AttemptRecord`:

```ts
export interface AttemptRecord {
  number: number;
  status: AttemptStatus;
  session_id?: string;
  branch?: string;
  workspace_path?: string;  // NEW — absolute path of the worktree, used by `aow show --hops`
  started_at: string;
  ended_at?: string;
  duration_ms?: number;
  outputs?: Record<string, string>;
  inputs?: Record<string, string>;
  feedback?: string;
  failure_reason?: string;
}
```

(If your codebase already declares some of those fields differently, match the existing style — do not refactor the surrounding fields.)

### 2. `packages/workflow/src/state-store.ts`

Extend the Zod schema for `AttemptRecord` to permit `workspace_path: z.string().optional()`. Verify existing tests pass.

### 3. `packages/workflow/src/engine/step-runner.ts`

Wherever an `AttemptRecord` is constructed, capture `workspace_path` from the running session (via `getSessionWorkspacePath` — added in 3.2).

There are typically three sites:
- The inline "in-progress" record set during `updateStep(running)` — set `workspace_path` here as soon as you have it (i.e. immediately after `spawnAgentSession` returns).
- The success path (where the record gets pushed to `history` with `status: "succeeded"`).
- The failure path (`recordFailedAttempt` or equivalent).

If `getSessionWorkspacePath` returns `null` (session reaped, etc.), omit the field — don't crash.

Pattern:
```ts
const workspacePath = (await getSessionWorkspacePath(ctx.aoCtx, sessionId)) ?? undefined;
const attemptRecord: AttemptRecord = {
  number: attempts + 1,
  status: "in_progress",
  session_id: sessionId,
  branch,
  workspace_path: workspacePath,
  started_at: startedAt,
  inputs,
};
```

Cache the `workspacePath` in `runAgentStep`'s local scope after the first lookup so the lint call (added in 3.4) and the attempt record use the same value.

### 4. `packages/workflow/src/cli.ts`

Add a `--hops` flag to the `show` command. Behavior:

- `aow show <runId> --hops`: Print the existing `show` output, then for each step (or only the step specified by `--step`), print a `Hop Trail` section reading from `<workspacePath>/.ao/ref-hops.jsonl`. Filter entries by `step_id === stepId`. Render as:

```
  Hop Trail (5 hops, exceeds limit of 4):
    1. design.md#overview            ok       exact_substring
    2. design.md#auth-flow            ok       normalized_substring  weak (0.78)
    3. design.md#missing               error    section_not_found
    4. design.md#oauth                 ok       token_overlap
    5. design.md#refresh                ok       exact_substring
```

Columns:
- Hop number (1-indexed)
- Ref (truncate to 35 chars with ellipsis if longer)
- Outcome (`ok` | `error` — colorize green/red via `chalk`)
- Match kind (`exact_substring` | `normalized_substring` | `token_overlap` | `n/a` for errors)
- (Optional 5th column) `weak (0.XX)` if `match_kind === "token_overlap"` and the resolver recorded `claim_match.confidence < 1.0` in the hop log. (You'll need to update §17.1's hop-line schema to include `match_kind` and `confidence`; this is a §17.5 requirement.)

If `--step` is supplied: render only that step's hop trail. If not: render all steps in order. If a step has no `workspace_path` recorded (legacy data, or step never ran): print `  Hop Trail: (no workspace recorded)`. If `workspace_path` exists but the hop file is missing or empty: print `  Hop Trail: (no hops)`. **Never crash on a missing file.**

If both `--hops` and `--json` are supplied: attach a `hops: HopRecord[]` array to each step in the JSON output.

Resolving the workspace path: use the LATEST attempt's `workspace_path` (the head of `history`, or `current_attempt`). If both exist, prefer `current_attempt`.

Reuse the `chalk` import already in the file. Do not add a new dep.

Stay under 400 LOC for `cli.ts`. If hop rendering pushes it over, extract a helper into `packages/workflow/src/cli/render-hops.ts`.

### 5. `packages/workflow/src/resolver/script.ts` (small change)

The resolver script writes hop entries to `.ao/ref-hops.jsonl`. §17.1's line schema must include `match_kind` and (when applicable) `confidence` so `aow show --hops` can render the 4th and 5th columns. Update the hop-log line shape to:

```jsonc
{
  "ts": "2025-...",
  "step_id": "...",
  "ref": "design.md#overview",
  "outcome": "ok",         // or "error"
  "match_kind": "exact_substring",  // or "normalized_substring" | "token_overlap" | "n/a"
  "confidence": 1.0,        // OMIT for non-token-overlap matches and for errors
  "error_kind": "section_not_found"  // ONLY when outcome === "error"
}
```

This is a small additive change to 3.1's hop-line writer — existing fields are preserved, two are added. Update the resolver's unit tests to cover the new fields.

Be explicit in the commit/PR body that this is a §17.1 schema follow-up needed by §17.5.

## Files to Create

### 6. `packages/workflow/src/__tests__/cli-hops.test.ts`

At least 6 tests covering the hop-rendering logic:

1. **No `--hops`**: `aow show` output is unchanged (regression guard).
2. **Empty hop file**: prints `(no hops)` line, exits 0.
3. **Missing workspace_path**: prints `(no workspace recorded)`, exits 0.
4. **Renders multiple hops**: feed a fixture jsonl with 3 entries, assert all 3 appear, in order, with correct columns.
5. **Hop count warning**: feed 5 entries, assert the header reads `Hop Trail (5 hops, exceeds limit of 4):` with red coloring (strip ANSI for the assertion — `chalk` colors can be tested by checking for the escape sequence or by using `chalk.level = 0` in setup).
6. **`--step` filter**: feed two steps' worth of entries; assert only the requested step's trail is rendered.
7. **`--json --hops`**: assert each step in the JSON output has a `hops: HopRecord[]` field.

### 7. `packages/workflow/src/__tests__/phase-3-real-ao.integration.test.ts`

The Phase 3 capstone test. End-to-end:

- Spin up a real `ao-core` `SessionManager` against a temp project dir (look at `packages/integration-tests/` for the pattern — there should be at least one example of constructing a real SessionManager in tests).
- Write a tiny fixture workflow at the temp project root: 1 step, agent `claude-code` (the default), one input artifact (a small markdown file with one H2 section and one paragraph), one output (a markdown file).
- **Mock only the agent's stdin/output side**: have the test inject the agent's outputs by writing the output file directly (you cannot run actual Claude Code in CI). The agent's "session" is a no-op tmux/process session that exits cleanly.
- First attempt: write an output containing a deliberately broken citation (`<!-- ref: design.md#section-that-doesnt-exist claim="x" -->`).
- Assert:
  - Run state shows the step as having 1 failed attempt with `failure_reason: "citations_invalid"`.
  - Feedback file exists at `feedback/<stepId>-attempt-2.md` with the section-not-found error.
  - The attempt record has `workspace_path` populated.
  - `.ao/ref-hops.jsonl` exists in the workspace and contains the lint's hop entries (with `step_id` ending in `-lint`).
- Trigger a retry (kick the engine; in v1 retries are typically triggered by re-running `aow run`). On the retry, write a clean output with a valid citation.
- Assert:
  - Second attempt succeeds, step status is `completed`.
  - The retry's prompt (capturable by intercepting `spawnAgentSession`) includes the linter feedback prepended.
  - `aow show <runId> --hops` (invoked via `execFile` on `dist/cli.js`) prints both attempts' hop trails.

If wiring a real SessionManager is too fragile in CI (no tmux available on GitHub Actions, no claude-code binary, etc.), gate this test with `describe.skipIf(process.env.AOW_SKIP_REAL_AO === "1", ...)` and document the env var in the PR description and the test file's top-of-file comment. The CI workflow may need to set `AOW_SKIP_REAL_AO=1` until a runtime is provisioned. **Document this clearly** — silent skipping is the worst outcome.

Local-developer runs (without the env var) MUST execute the test fully.

## Hard Constraints

- Modify ONLY `packages/workflow/`. New files: `cli-hops.test.ts`, `phase-3-real-ao.integration.test.ts`, optional `cli/render-hops.ts`. Modify: `types.ts`, `state-store.ts`, `engine/step-runner.ts`, `cli.ts`, `resolver/script.ts` (additive only — two new fields in the hop-line schema).
- DO NOT redesign existing `show` output. The `--hops` flag adds a section; nothing else changes.
- DO NOT introduce a table library. Hand-pad columns.
- The resolver-script change is additive (new fields, no removed fields). Existing 3.1 tests must still pass.
- `cli.ts` must remain under 400 LOC. Extract a helper if needed.
- The real-AO test must skip gracefully on CI if the runtime isn't available, but MUST run by default on a developer's machine. Document the skip env var loudly in the test file's header comment.
- Strict TS. No `any`.
- Default agent stays `claude-code`. The integration test workflow uses `agent: claude-code` (the default).
- DO NOT touch `prompt-template.ts`, `citation-linter.ts`, `workspace-setup.ts`, `errors.ts` — they're locked-in from 3.1–3.4.

## Why Capture `workspace_path` on `AttemptRecord`

Two reasons:
1. Operator visibility — `aow show --hops` needs a way to find the hop log for past attempts (worktrees may still exist post-run).
2. Forensic value — if a step succeeded but later turned out to have lint warnings the operator missed, they can `cd` into the recorded `workspace_path` and re-examine the outputs and hop log.

We don't add this to the public `Session` type because it's already there (`Session.workspacePath`); we copy it into the attempt record so the workflow run is self-contained and inspectable without round-tripping through the session manager (which may have reaped the session).

## Acceptance — All Must Pass

```bash
pnpm --filter @aoagents/ao-workflow build
pnpm --filter @aoagents/ao-workflow test    # unit tests + cli-hops + real-AO integration (or skipped with env var)
pnpm typecheck                              # whole repo

# Manual smoke (paste in PR body):
# 1. Run a fixture workflow that produces hops.
# 2. aow show <runId> --hops
# 3. Capture stdout and paste it.
```

## When Done

1. Verify all acceptance.
2. Commit: `feat(workflow): phase 3.5 — aow show --hops + real-AO integration test`
3. Push.
4. `gh pr create --base feature/workflow-engine --title 'feat(workflow): phase 3.5 — aow show --hops + real-AO integration test'`
5. PR body must include:
   - The captured `aow show --hops` output (so reviewers see the column layout)
   - Confirmation that all acceptance commands pass
   - A note: "Phase 3 is now feature-complete. The optional 3.6 self-verification example workflow is a follow-up."
   - If you gated the real-AO test with `AOW_SKIP_REAL_AO`, justify it (which CI capability is missing) and link a follow-up issue to enable it.

## Out of Scope (DO NOT DO IN THIS PR)

- Self-verification example workflow — 3.6 (deferred).
- Any new `aow` subcommand. `--hops` is a flag on the existing `show` command.
- Telemetry / metrics emission for hop counts — §17.6 explicitly out of scope.
- Per-step `strict_citations:` YAML field — §17.6 explicitly out of scope.
- Auto-retry on linter failures without operator action — §17.6 explicitly out of scope; existing retry path is operator-triggered.
- Changing the default agent from `claude-code`.
- Any change outside `packages/workflow/`.
