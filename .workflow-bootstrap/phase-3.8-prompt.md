# Phase 3.8 — Fix Dogfood Blockers

## Why

Phase 3.7 dogfooded `aow` on a 4-step URL-shortener workflow. Three runs, three failures, all at step 1. Findings recorded at `docs/aow-dogfood-findings.md`. This phase fixes the surfaced blockers so the engine can run a real workflow end-to-end.

## Required reading (in order)

1. **`docs/aow-dogfood-findings.md`** — the actual symptoms, run-by-run. Read it end-to-end. Every fix below maps to a finding.
2. `docs/workflow-engine.md` §17 (Reference Resolution / Citation Validation) — design contract for the citation layer.
3. `docs/workflow-engine.md` §4 ("Revision Loop Cap") — design contract for the revision loop.
4. `packages/workflow/src/resolver/script.ts` and `packages/workflow/src/citation-linter.ts` — current implementation.
5. `packages/workflow/src/engine.ts` (or `engine/step-runner.ts` if extracted) — where the failure-handling lives.

## Fixes to land (priority order, all in one PR)

### Fix 1 — Resolver consults step `inputs:` map

**Symptom:** Workflow `inputs.requirements: ../requirements.md` + agent cites `<!-- ref: requirements.md#... -->` → resolver reports `File not found: requirements.md`.

**Behavior to implement:**
- The resolver receives the step's `inputs:` map alongside the citation.
- When resolving a citation path `foo.md`:
  1. If the step has an input whose name OR basename equals `foo.md`, resolve to that input's absolute path. **Use this path.**
  2. Otherwise, fall back to existing filesystem resolution relative to `workspacePath`.
- The `citation-linter.ts` `LintInputs` interface gains an `inputs: Array<{ name: string; path: string }>` field. The engine populates it from the step definition.
- The resolver subprocess receives it via a CLI flag (e.g. `--inputs '<json>'`) — keep the subprocess interface JSON-encodable.

**Tests to add:**
- Citation `requirements.md` resolves to the input path when step has `inputs.requirements: /abs/path.md`.
- Citation `requirements.md` falls back to filesystem when no matching input.
- Basename match works (input named `req`, citation `requirements.md` → match if `inputs.req` points at a `requirements.md`).
- Existing tests still pass.

### Fix 2 — Resolver accepts GitHub-style heading slugs

**Symptom:** Heading `## Out of scope` → agent cites `out-of-scope` → resolver reports `Claim did not match section "out-of-scope"`.

**Behavior to implement:**
- The resolver, when matching a citation's `#fragment` against a heading, normalizes both sides using the standard GitHub slug rule:
  - lowercase
  - strip non-word characters except `-` and ` `
  - whitespace runs → single `-`
  - leading/trailing `-` stripped
- Accept the literal heading text as a slug too (for users who write `<!-- ref: file.md#Out of scope -->`).

**Tests to add:**
- `## Out of scope` matches `out-of-scope`, `Out of scope`, `out_of_scope` (legacy underscore form, if currently supported — preserve or document the change).
- `## API: usage details` matches `api-usage-details`.
- Document the exact rule in `docs/aow-guide.md` §3 and `docs/workflow-engine.md` §17.

### Fix 3 — `citations_invalid` triggers revision loop

**Symptom:** `state.json` shows `failure_reason: "citations_invalid"`, engine marks run `failed`, no second attempt.

**Behavior to implement:**
- In the step result handler (engine.ts ~line 164, where `outcome.kind === "failed"`), when `outcome.reason === "citations_invalid"` AND `step.attempts < step.max_revisions ?? 3`:
  - Do NOT mark the run failed.
  - Increment `step.attempts`.
  - Compose feedback text from the `LintReport.errors` (first 5, formatted as bullet list with kind + message + detail).
  - Re-enter the spawn loop for that step with `feedback` prepended to the prompt via existing `prompt-template.ts` machinery.
  - Cap at `max_revisions` (default 3).
- When the cap is hit, THEN mark the run failed with the same `citations_invalid` reason and the final `LintReport` preserved.

**Tests to add:**
- Step fails lint once → re-runs with feedback → passes lint on attempt 2 → step completes.
- Step fails lint `max_revisions` times → step marked failed, run failed.
- Spawn failure (not citations_invalid) does NOT trigger revision — still aborts the run as today.

### Fix 4 — Persist `LintReport` into state.json

**Symptom:** `aow run` says `citation lint failed: 11 error(s)`. Errors invisible without writing a Node one-liner.

**Behavior to implement:**
- `state.json` per-step `current_attempt` gains a `lint_report?: LintReport` field.
- On lint failure, the report is written before the engine decides whether to revise or abort.
- `aow run` prints the first 5 errors to stderr (use existing `log.error`).

**Tests to add:**
- Verify `state.json` contains the report after a lint failure.
- Verify stderr output includes error bullets.

### Fix 5 — Cross-run worktree cleanup

**Symptom:** Wiping `.workflow-state/` and re-running fails: `'aow-...-design-1' is already used by worktree at ust-1`.

**Behavior to implement (pick one):**
- **Option A (preferred):** include the workflow's `run_id` in the branch name (`aow-<workflow>-<step>-<runid>-<attempt>`). Eliminates collisions structurally. Existing runs migrate via state.json's preserved branch; new runs get the new pattern.
- **Option B (fallback):** at engine start, scan AO sessions for branches matching `aow-<workflow>-*` whose run-id isn't in the current run's `state.json`. Kill them with `auto_cleanup` reason. Print one-line warning per killed session.

Either approach: add an `aow clean [<run-id>|--all]` CLI command that kills dangling sessions/worktrees explicitly. Document in `docs/aow-guide.md` §8 (Troubleshooting).

**Tests to add:**
- Two runs of the same workflow can coexist without branch collision.
- `aow clean --all` removes stale sessions and frees branches.

## Hard constraints

- Modify ONLY `packages/workflow/`. Do not touch core, cli, aow, plugins/, web.
- Strict TS, no `any`, per-file LOC cap 400 (split engine into submodules if needed — engine.ts is already past 250 lines).
- All existing 151 tests stay green. New tests added for each fix.
- Open ONE PR targeting `feature/workflow-engine` with all 5 fixes. PR body lists each fix + corresponding finding from `docs/aow-dogfood-findings.md`.

## Acceptance

```bash
pnpm --filter @aoagents/ao-workflow build
pnpm --filter @aoagents/ao-workflow test     # 151 + new tests pass
pnpm typecheck                                # whole repo
```

Manual re-dogfood after merge (the human runs this, not the worker):
```bash
rm -rf ~/aow-test-url-shortener/.workflow-state ~/aow-test-url-shortener/artifacts
cd ~/aow-test-url-shortener && node /Users/aryangaurav/agent-orchestrator/packages/aow/bin/aow.js run workflow.yaml
# expected: design completes (possibly after 1-2 revision attempts), hld starts.
```

## When done

1. Verify all acceptance.
2. Commit: `feat(workflow): phase 3.8 — fix 5 dogfood blockers (resolver inputs, slug match, revision loop, lint state, cleanup)`
3. Push.
4. PR: `gh pr create --base feature/workflow-engine --title 'feat(workflow): phase 3.8 — fix 5 dogfood blockers'`
5. PR body lists each fix + the finding it resolves. Include before/after of the manual dogfood smoke if possible.

## Out of scope

- The annoyances (#4 `ao kill` shortcut, #5 `aow logs` command, friction items) — separate phase.
- Fixing the workflow.yaml fixture itself — the engine should handle realistic workflows as-written.
- Publishing `@aoagents/aow` to npm.
- Any file outside `packages/workflow/`.
