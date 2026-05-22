# Phase 3.9 — Fix Spawn-Race + Build-Freshness + Zombie Sessions

## Why

Phase 3.8 fixed the citation/revision blockers. Re-dogfood (Run 4 in `docs/aow-dogfood-findings.md`) confirmed all 5 fixes work, but surfaced 3 new issues that block end-to-end runs:

1. **Spawn race (Finding 7)** — engine declares `hld` agent dead 88ms after spawn. claude-code's PTY attach takes >100ms; engine sees `status=spawning, activity=exited` and treats it as terminal. The agent actually produced `hld.md` successfully *after* the engine gave up.
2. **Build freshness (Finding 6)** — `aow` silently runs stale `dist/` after a `git pull`. Phase 3.8 was invisible until manual rebuild.
3. **Zombie sessions (Finding 8)** — revision loop leaves prior-attempt tmux sessions orphaned. Up to 12 zombies per multi-step run.

Fix #1 is the critical blocker — every multi-step workflow hits it intermittently. Fix #2 is a silent-failure UX trap. Fix #3 is cleanup quality.

## Required reading (in order)

1. **`docs/aow-dogfood-findings.md` §"Run 4"** — symptoms with timestamps and evidence (read the full Run 4 section, including the table and Findings 6/7/8).
2. `packages/workflow/src/engine/step-runner.ts` and any `engine/completion-detector.ts` (or equivalent in `engine/`) — where session-status polling decides terminal.
3. `packages/workflow/src/ao-client.ts` — `getSessionStatus` returns `{status, activity, lastActivityAt}`. The spawn-race classification uses these fields.
4. `packages/core/src/lifecycle-state.ts` — canonical session states. Understand what `spawning`, `working`, `idle`, `terminated` mean and which are truly terminal.
5. `packages/workflow/src/cli.ts` and `packages/aow/bin/aow.js` — where to add the build-freshness check.

## Fixes to land (priority order, all in one PR)

### Fix 1 — Spawn-race: never declare `spawning` terminal

**Symptom.** Session created at T+0, marked failed at T+88ms with `status='spawning', activity='exited'`. The agent then ran successfully and produced its outputs, but the engine had already aborted the step.

**Behavior to implement:**
- In the step-runner's session-polling loop, the terminal-classification check must NOT mark a session failed while its `status` is `spawning`, regardless of `activity` value. `spawning` is a transient setup state — `activity=exited` during this window means "PTY hasn't attached yet," not "agent died."
- A spawned session is only eligible for terminal classification once it has transitioned to a post-spawn status (`working`, `idle`, `needs_input`, `done`, or a true terminal like `terminated`).
- Defense-in-depth: also apply a minimum grace period of **30s** from `started_at` before declaring exit-without-outputs, even on non-`spawning` statuses. Catches edge cases where the status transitions in <30s but the agent is still bootstrapping.
- Preserve the existing "agent done + idle ≥30s but no outputs" check — that one is correct and should still fail the step.

**Tests to add:**
- Session reports `status='spawning', activity='exited'` for 5 consecutive polls → step does NOT fail; runner keeps polling.
- Session reports `status='working'` then transitions to `terminated` with no outputs after >30s → step fails (existing behavior preserved).
- Session reports `status='idle'` with no outputs at T+10s → step does NOT fail (within grace).
- Session reports `status='idle'` with no outputs at T+45s → step fails (past grace).
- Session reports `status='working'` then produces outputs at T+5s → step completes.

### Fix 2 — Build-freshness warning

**Symptom.** User pulls a PR that ships compiled-from-source fixes; runs `aow run`; nothing changes because `packages/workflow/dist/` still holds the pre-PR build. No warning, no error.

**Behavior to implement:**
- In `packages/workflow/src/cli.ts` (top of the entry function, before any command dispatch), compute:
  - `srcLatest = max(mtime of all packages/workflow/src/**/*.ts)`
  - `distLatest = max(mtime of all packages/workflow/dist/**/*.js)`
- If `srcLatest > distLatest`, print a yellow warning to stderr:
  ```
  warn  workflow source is newer than dist (src: <iso>, dist: <iso>)
  warn  run: pnpm --filter @aoagents/ao-workflow build
  ```
- Do NOT block execution. Warning only.
- Skip the check if `dist/` doesn't exist (fresh checkout — let the existing import errors surface naturally).
- Skip the check if running from a published npm install (no `src/` directory next to `dist/`).

**Tests to add:**
- Mock filesystem: src newer than dist → warning emitted to stderr.
- src older than dist → no warning.
- dist missing → no warning, no crash.
- src missing (published install) → no warning, no crash.

### Fix 3 — Revision loop kills prior session

**Symptom.** Each revision attempt spawns a fresh `ust-N`. The prior attempt's session lives on in tmux forever. After 4 steps × 3 attempts = up to 12 zombies.

**Behavior to implement:**
- In the revision-loop spawn site (`engine/citation-step.ts` or wherever attempt N+1 is launched), before spawning the new session, call `killSession(ctx, priorSessionId, 'auto_cleanup')` on the just-failed attempt's session.
- Use the existing `killSession` helper from `ao-client.ts` — already supports a kill reason.
- Best-effort: if the kill fails (session already gone), log a debug-level message and continue.
- The branch + worktree are preserved (that's AO's concern). We only free the tmux session.

**Tests to add:**
- Two-attempt revision: after spawn of attempt 2, `killSession` was called with attempt 1's session-id and reason `auto_cleanup`.
- Kill failure is swallowed: if `killSession` throws, the new spawn still proceeds.
- Single-attempt success path: no kill is called (no prior session).

## Hard constraints

- Modify ONLY `packages/workflow/`. Do not touch core, cli, aow, plugins/, web. Exception: if Fix 2 needs a helper in `packages/aow/bin/aow.js`, that's allowed — but prefer doing it inside `packages/workflow/src/cli.ts`.
- Strict TS, no `any`, per-file LOC cap 400.
- All existing tests stay green. New tests added for each fix.
- Open ONE PR targeting `feature/workflow-engine` with all 3 fixes. PR body lists each fix + its finding from `docs/aow-dogfood-findings.md`.

## Acceptance

```bash
pnpm --filter @aoagents/ao-workflow build
pnpm --filter @aoagents/ao-workflow test
pnpm typecheck
```

Manual re-dogfood after merge (human runs this):
```bash
rm -rf ~/aow-test-url-shortener/.workflow-state ~/aow-test-url-shortener/artifacts
cd ~/aow-test-url-shortener && node /Users/aryangaurav/agent-orchestrator/packages/aow/bin/aow.js run workflow.yaml
# expected: design completes (possibly 1-2 revisions), hld completes, impl starts.
# only one zombie ust-* per step at any time.
```

## When done

1. Verify acceptance.
2. Commit: `feat(workflow): phase 3.9 — fix spawn race, build freshness, zombie sessions`
3. Push.
4. PR: `gh pr create --base feature/workflow-engine --title 'feat(workflow): phase 3.9 — fix spawn race + build freshness + zombie sessions'`
5. PR body: each fix + the finding it resolves.

## Out of scope

- Fixes inside AO core (lifecycle-state, session-manager).
- Publishing `@aoagents/aow` to npm.
- The `hld`-step-specific behavior (it was a victim of the spawn race, not a broken step).
- New citation-linter rules.
- Any file outside `packages/workflow/` (except optional 1-line tweak to `packages/aow/bin/aow.js` for Fix 2).
