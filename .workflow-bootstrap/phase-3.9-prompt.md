# Phase 3.9 — Fix Spawn-Race + Build-Freshness + Zombie Sessions

## Required Reading

1. **`docs/aow-dogfood-findings.md` — read the entire "Run 4" section.** Findings 6/7/8 are the source of truth for symptoms, timestamps, and root-cause hypotheses. Every fix here maps to one of those findings.
2. **`packages/workflow/src/completion-detector.ts`** — the polling loop that decides "step done / failed / timeout." This is where Fix 1 lives. Lines 96–101 (`isTerminalSnapshot`) and line 99 specifically (`if (snapshot.activity === "exited") return true;`) are the bug.
3. **`packages/workflow/src/engine/step-runner.ts`** — the per-step orchestrator. Read end-to-end (~352 LOC). Pay attention to lines 90–110 (spawn site) and lines 180–193 (revision-loop branch — where Fix 3 wires in).
4. **`packages/workflow/src/ao-client.ts`** — the AO facade. `getSessionStatus` returns `SessionStatusSnapshot` (status + activity + lastActivityAt). `killSession(ctx, sessionId, reason?)` already exists and accepts the lifecycle kill reasons.
5. **`packages/core/src/lifecycle-state.ts`** — canonical `SessionStatus` values: `not_started`, `working`, `idle`, `needs_input`, `stuck`, `detecting`, `done`, `terminated`. (Legacy status types include `spawning` — see `deriveLegacyStatus`.) Fix 1 needs to know which of these are "transient setup" vs "truly terminal."
6. **`packages/workflow/src/cli.ts`** — entrypoint (`#!/usr/bin/env node`), lines 1–60. Fix 2 inserts a build-freshness check near the top of the entry function, before any command dispatch.
7. **`CLAUDE.md`** — repo conventions.

## The Bugs in Detail

### Bug 1 (Finding 7) — Spawn race in completion-detector

`completion-detector.ts:96-101`:

```typescript
function isTerminalSnapshot(snapshot: SessionStatusSnapshot | null): boolean {
  if (!snapshot) return true;
  if (TERMINAL_STATUSES.has(snapshot.status)) return true;
  if (snapshot.activity === "exited") return true;   // ← BUG
  return false;
}
```

`activity === "exited"` is the **default state for the first poll** of any freshly-spawned claude-code session — the PTY hasn't attached yet, so no process appears to be running. The engine immediately classifies the step as failed.

Run-4 evidence: `ust-6` was created at `2026-05-22T03:36:30.565Z`, marked failed at `03:36:30.653Z` (**88ms** later). The agent then continued running and produced a complete `hld.md` (244 lines) — proving the agent was never actually dead, just slow to attach.

### Bug 2 (Finding 6) — Stale dist after `git pull`

`packages/workflow/dist/` is built by `tsc`. `aow` runs the dist. After `git pull` lands new source, `dist/` is unchanged until the user runs `pnpm --filter @aoagents/ao-workflow build`. There's no warning. Phase 3.8 was invisible in production until rebuilt — exactly what happened to us on the first re-dogfood attempt.

### Bug 3 (Finding 8) — Zombie sessions per revision

`step-runner.ts:180-193`:

```typescript
if (canRevise) {
  await writeCitationFeedback(ctx.runDir, step.id, attempts + 1, lintReport);
  await updateStep(ctx.runDir, step.id, (prev) => ({
    ...prev,
    status: "pending",
    failure_reason: undefined,
    current_attempt: undefined,
    history: [...(prev.history ?? []), attemptRecord],
  }));
  log.warn(`[${step.id}] citation lint failed: ...; revising (attempt ${attempts}/${maxRevisions})`);
  return { kind: "revise" };
}
```

The just-failed `sessionId` is recorded in `attemptRecord` then forgotten. The next attempt spawns a fresh session at `step-runner.ts:~98-102`. The prior session's tmux pane is never killed. After 4 steps × up to 3 attempts = up to 12 zombies per workflow run.

## Files to Modify

### 1. `packages/workflow/src/completion-detector.ts` (Fix 1)

**Change `isTerminalSnapshot` (line 96) to:**

```typescript
const POST_SPAWN_STATUSES = new Set([
  "working", "idle", "needs_input", "stuck", "detecting", "done", "terminated",
]);

function isTerminalSnapshot(
  snapshot: SessionStatusSnapshot | null,
  startedAt: number,
  spawnGraceMs: number,
): boolean {
  if (!snapshot) {
    // Session disappearing entirely IS terminal — but not during grace window
    // (it may simply not be registered yet).
    return Date.now() - startedAt >= spawnGraceMs;
  }
  if (TERMINAL_STATUSES.has(snapshot.status)) return true;

  // Activity-based exit only counts if the session has transitioned past
  // spawn-time setup. `activity === "exited"` while status is still
  // `not_started` / `spawning` (legacy) means the PTY hasn't attached, not
  // that the agent died.
  if (snapshot.activity === "exited" && POST_SPAWN_STATUSES.has(snapshot.status)) {
    return true;
  }

  return false;
}
```

**Add a constant for the grace window** near the existing constants (line 39):

```typescript
const DEFAULT_SPAWN_GRACE_MS = 30_000;
```

**Thread `spawnGraceMs` through `WaitForStepCompletionOptions`** (line 24) — optional, defaults to `DEFAULT_SPAWN_GRACE_MS`.

**Update the polling loop** (line 58) — capture `startedAt = Date.now()` before the `for` loop (already done as `start`), and pass `start` + `spawnGraceMs` into `isTerminalSnapshot` at line 62.

**Reasoning:**
- `not_started` and legacy `spawning` are transient. Activity-based exit during them is meaningless.
- Once the session has reached any post-spawn status, `activity === "exited"` IS a real signal — preserve that.
- `snapshot === null` becoming terminal only after grace handles the race where the session ID isn't in AO's registry yet.
- The 30s grace is a defense-in-depth backstop; the status-gating is the primary fix.

### 2. `packages/workflow/src/engine/step-runner.ts` (Fix 3)

**At lines 180–193 (the revision branch), capture the prior session ID before the new attempt spawns.** The new attempt is spawned by returning `{ kind: "revise" }`, which causes the outer loop in `engine.ts` to re-enter `runAgentStep`. So the kill needs to happen here, before returning:

```typescript
if (canRevise) {
  await writeCitationFeedback(ctx.runDir, step.id, attempts + 1, lintReport);
  await updateStep(ctx.runDir, step.id, (prev) => ({
    ...prev,
    status: "pending",
    failure_reason: undefined,
    current_attempt: undefined,
    history: [...(prev.history ?? []), attemptRecord],
  }));
  // Free the failed attempt's tmux session. Branch + worktree are preserved
  // for forensics — only the session is reclaimed. Best-effort.
  await killSession(ctx.aoCtx, sessionId, "auto_cleanup").catch((err) => {
    log.warn(`[${step.id}] failed to kill prior session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
  });
  log.warn(
    `[${step.id}] citation lint failed: ${lintReport.errors.length} error(s); revising (attempt ${attempts}/${maxRevisions})`,
  );
  return { kind: "revise" };
}
```

`killSession` is already imported (line ~20-30 of step-runner.ts uses it for timeout cleanup at line 139). No new imports needed.

### 3. `packages/workflow/src/cli.ts` (Fix 2)

**Add a new helper `warnIfBuildStale()` and call it at the top of the entry function** (the function that runs when `node dist/cli.js` is invoked — likely at the bottom of the file or in a `main()` wrapper):

```typescript
import { stat, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

async function warnIfBuildStale(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url)); // .../packages/workflow/dist
  const pkgRoot = dirname(here);                         // .../packages/workflow
  const srcDir = join(pkgRoot, "src");
  const distDir = join(pkgRoot, "dist");

  try {
    const [srcLatest, distLatest] = await Promise.all([
      latestMtime(srcDir, /\.ts$/),
      latestMtime(distDir, /\.js$/),
    ]);
    if (srcLatest === null || distLatest === null) return;  // published install or no dist
    if (srcLatest <= distLatest) return;
    log.warn(
      `workflow source is newer than dist (src: ${new Date(srcLatest).toISOString()}, dist: ${new Date(distLatest).toISOString()})`,
    );
    log.warn("run: pnpm --filter @aoagents/ao-workflow build");
  } catch {
    // Best effort — never block command execution on a freshness check.
  }
}

async function latestMtime(dir: string, pattern: RegExp): Promise<number | null> {
  let latest = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = await latestMtime(p, pattern);
        if (sub !== null && sub > latest) latest = sub;
      } else if (pattern.test(entry.name)) {
        const s = await stat(p);
        if (s.mtimeMs > latest) latest = s.mtimeMs;
      }
    }
  } catch {
    return null;
  }
  return latest > 0 ? latest : null;
}
```

**Call site:** at the top of the `main` async function (or wherever the commander program is awaited), invoke `await warnIfBuildStale();` BEFORE `program.parseAsync(argv)`. This way the warning prints before any command output.

**Reasoning:** print to stderr via existing `log.warn`. Non-blocking. Returns `null` and silently skips if either tree is missing (published install or fresh checkout) — those failure modes are caught by other error paths.

### 4. Tests to add

Add to `packages/workflow/src/__tests__/completion-detector.test.ts` (create if missing):

- **Spawn race not classified terminal:** `snapshot = { status: "not_started", activity: "exited", lastActivityAt: null }` at T+0 → `isTerminalSnapshot` returns `false`. Same snapshot at T+31s → returns `false` (status still pre-spawn, activity decision gated on status). Test confirms NO false-terminal during spawn race regardless of how long it takes.
- **Real exit after spawn IS terminal:** `snapshot = { status: "working", activity: "exited", ... }` → returns `true` (post-spawn status + exited activity).
- **Truly-dead session is terminal after grace:** `snapshot = null` at T+0 → returns `false` (within grace). Same at T+31s → returns `true`.
- **End-to-end via `waitForStepCompletion`:** mock `getSessionStatus` to return `{status: "not_started", activity: "exited"}` for 3 polls, then `{status: "idle", activity: "idle"}` with outputs present → result is `completed`, NOT `failed`.

Add to `packages/workflow/src/__tests__/cli.test.ts` (create if missing):

- **Build stale warning:** mock `latestMtime` (or use a temp dir with carefully-set mtimes) so src > dist → `log.warn` called with "source is newer".
- **Build fresh, no warning:** src <= dist → no warn.
- **Missing dist:** `latestMtime(distDir, ...)` returns `null` → no warn, no throw.
- **Missing src (published install):** same — no warn.

Add to `packages/workflow/src/__tests__/integration/phase-3-9.integration.test.ts` (mirror the existing `phase-3-8.integration.test.ts`):

- **Revision loop kills prior session:** mock `killSession` and force a citation lint failure on attempt 1. Assert `killSession` was called with the attempt-1 sessionId and reason `"auto_cleanup"`. Assert the new attempt then spawns a different sessionId.
- **Kill failure is non-fatal:** `killSession` rejects → revision still proceeds; warning is logged.

## Hard Constraints

- Modify ONLY `packages/workflow/`. Do not touch core, cli, aow, plugins/, web.
- Strict TS. No `any`. Per-file LOC cap 400.
- All existing tests stay green. Add tests for each fix as described above.
- One PR targeting `feature/workflow-engine` with all 3 fixes.
- Use `git pull` (merge), not `git pull --rebase`, if you need to sync the base branch.

## Acceptance — All Must Pass

```bash
pnpm --filter @aoagents/ao-workflow build
pnpm --filter @aoagents/ao-workflow test     # existing + new tests pass
pnpm typecheck                                # whole repo
```

Manual smoke (document in PR body; the human re-runs the real dogfood post-merge):

```bash
# 1. Fix 2: stale-dist warning fires.
touch packages/workflow/src/cli.ts
node packages/workflow/dist/cli.js --help   # expect: "warn  workflow source is newer than dist ..."

# 2. Rebuild → warning silenced.
pnpm --filter @aoagents/ao-workflow build
node packages/workflow/dist/cli.js --help   # no warning
```

## When Done

1. Verify all acceptance.
2. Commit: `feat(workflow): phase 3.9 — fix spawn race + build freshness + zombie sessions`
3. Push.
4. PR: `gh pr create --base feature/workflow-engine --title 'feat(workflow): phase 3.9 — fix spawn race + build freshness + zombie sessions'`
5. PR body should:
   - List each fix and the finding from `docs/aow-dogfood-findings.md` it resolves (Findings 6, 7, 8)
   - Confirm acceptance commands run green
   - Paste the Fix 2 manual smoke output (stale warning before, silent after)
   - Note: real dogfood verification is run by the human post-merge, not by the worker

## Out of Scope

- Fixes inside AO core (`lifecycle-state.ts`, `session-manager.ts`).
- Publishing `@aoagents/aow` to npm.
- New citation-linter rules or resolver behavior.
- The `hld`-step-specific prompt or fixture content.
- Any file outside `packages/workflow/`.
