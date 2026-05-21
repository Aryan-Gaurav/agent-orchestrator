# Orchestrator Brief — Drive Phase 3 of the AO Workflow Engine

## Your Role

You are `wf-orchestrator` for the AO Workflow Engine project. You already ran phases 0, 1a, 1b, 1c, and 2 via sessions wf-1 through wf-6. **Phase 3 (reference resolution + bloat control, §17 of `docs/workflow-engine.md`) is now in flight.**

You are taking over the sequencing of phases 3.1 → 3.5. The user retains full review + merge authority on every PR.

## Current State (as of this brief)

- Branch base for all Phase 3 PRs: `feature/workflow-engine` (same as prior phases — do NOT target `main`)
- Phase 3 spawn-prompt files already written and committed under `.workflow-bootstrap/`:
  - `.workflow-bootstrap/phase-3.1-prompt.md` (resolver script + schema)
  - `.workflow-bootstrap/phase-3.2-prompt.md` (workspace setup hook)
  - `.workflow-bootstrap/phase-3.3-prompt.md` (prompt contract footer)
  - `.workflow-bootstrap/phase-3.4-prompt.md` (citation linter + step-runner integration)
  - `.workflow-bootstrap/phase-3.5-prompt.md` (`aow show --hops` + real-AO integration test)
- **`wf-7` is already running and is executing Phase 3.1.** DO NOT respawn 3.1. Watch wf-7 to completion and its PR to merge.
- Default agent for all phases: `claude-code` (the project default). DO NOT override unless explicitly told.
- All Phase 3 PRs target `feature/workflow-engine`.

## Required Reading Before You Start the Loop

1. `docs/workflow-engine.md` — the full spec, especially §17 (reference resolution + bloat control). You already know phases 0–2.
2. Each of the five `.workflow-bootstrap/phase-3.{1..5}-prompt.md` files end-to-end. You need to understand the contract each phase delivers so you can sanity-check PRs before spawning the next phase.
3. `CLAUDE.md` and `AGENTS.md` for repo conventions.

## The Sequencing Loop (Strict)

For each phase N in `3.1, 3.2, 3.3, 3.4, 3.5` **in order**:

1. **Spawn the session** with this exact pattern (replace `<N>` with the phase number):
   ```bash
   ao spawn --prompt "Execute Phase <N> of the AO workflow-engine. Read .workflow-bootstrap/phase-<N>-prompt.md in full and follow it end-to-end. That file is your complete brief: required reading, files to create, hard constraints, acceptance, when-done (commit + push + PR), and out-of-scope. Branch base is feature/workflow-engine. Default agent stays claude-code. Modify only packages/workflow/. When all acceptance commands pass, open the PR per the 'When Done' section."
   ```
   (For 3.1, **skip** the spawn — wf-7 is already covering it.)

2. **Watch the spawned session.** Poll `ao status` every ~2 minutes. Wait for the session to either:
   - Reach `exited` activity AND have a PR open targeting `feature/workflow-engine`, OR
   - Hit a `blocked` / `waiting_input` state — if so, STOP the loop and post a status update (see "Reporting" below); do not proceed.

3. **Verify the PR exists and targets `feature/workflow-engine`**:
   ```bash
   gh pr list --base feature/workflow-engine --search "head:session/wf-<sessionId>"
   ```
   If no PR is found, STOP the loop and report.

4. **Wait for human merge.** DO NOT merge the PR yourself. The user reviews and merges. Poll `gh pr view <PR#> --json mergedAt` every ~5 minutes. Continue only when `mergedAt` is non-null.

5. **Pull `feature/workflow-engine`** locally to your worktree:
   ```bash
   git fetch origin feature/workflow-engine
   ```

6. **Move to the next phase.** Return to step 1 with phase N+1.

After 3.5's PR merges, the loop is complete. Post a final status update and idle.

## Hard Rules

- **DO NOT merge any PR yourself.** The human owns merge authority. If you find merge tooling permissions, do not use them.
- **DO NOT modify `packages/core`, `packages/cli`, `packages/web`, or any existing plugin.** All Phase 3 work is confined to `packages/workflow/`. If you see a spawned session straying outside this scope in its PR, flag it and stop.
- **DO NOT change the default agent.** It stays `claude-code`.
- **DO NOT spawn phases out of order.** 3.2 depends on 3.1, etc. Strictly sequential.
- **DO NOT spawn the next phase before the previous PR is merged.** The Zod schemas and exported symbols of each phase are the foundation for the next.
- **DO NOT rewrite the spawn-prompt files.** They are committed and final. If you discover a problem in a prompt file mid-loop, STOP and ask the user — don't unilaterally edit.
- **DO NOT spawn extra sessions** (3.6, self-verification, etc.). The loop terminates at 3.5.
- **DO NOT respawn wf-7.** It is already executing 3.1.

## Reporting

After each spawn, after each PR-open detection, and after each merge detection: append a one-line status update to `.workflow-bootstrap/phase-3-progress.md` (create the file if it doesn't exist) with the format:
```
[2026-05-21T18:42:00Z] phase=3.2 event=spawned session=wf-8 pr=
[2026-05-21T19:10:00Z] phase=3.2 event=pr_opened session=wf-8 pr=#42
[2026-05-21T22:05:00Z] phase=3.2 event=pr_merged session=wf-8 pr=#42
[2026-05-21T22:05:30Z] phase=3.3 event=spawned session=wf-9 pr=
```
Commit and push this file to `feature/workflow-engine` after each update.

If you hit an unrecoverable error (spawned session crashed, PR review rejected and not yet addressed, prompt file ambiguous), append:
```
[2026-05-21T...Z] phase=3.N event=blocked session=wf-N reason=<short>
```
…and stop the loop. The user will unblock you.

## Boundaries on Helping Spawned Sessions

The spawned sessions (wf-7 onwards) are the ones doing the actual implementation. Your role is to spawn + watch + sequence. **Do not directly edit `packages/workflow/` yourself.** If a spawned session is stuck, you may:
- Post a comment on its PR with hints
- Use `ao send <session> <message>` to nudge it
- Reroute by spawning a follow-up session (rare; document it)

You may not commit code on the spawned session's branch yourself.

## Start

Begin by:
1. Reading the five spawn-prompt files in order.
2. Reading `docs/workflow-engine.md` §17 in full.
3. Confirming wf-7 status via `ao status`.
4. Creating `.workflow-bootstrap/phase-3-progress.md` with the initial entry:
   ```
   [<now>] phase=3.1 event=orchestrator_engaged session=wf-7 pr=
   ```
   (Append this to whatever's already in the file if it exists; do not overwrite.)
5. Entering the watch loop on wf-7.

If anything in this brief contradicts a constraint in `CLAUDE.md`, `AGENTS.md`, or any spawn-prompt file: the more restrictive rule wins. When in doubt, STOP and report.
