# Phase 1c — AO Client + Completion Detector

## Required Reading

1. `docs/workflow-engine.md` — design spec. Read §4 (Completion Detection Contract), §9 (Module Responsibilities — ao-client + completion-detector). Skim the rest.
2. `packages/workflow/src/types.ts` — types from Phase 0. Reuse `ArtifactRef`.
3. `packages/workflow/src/errors.ts` — extend with new error classes if needed.
4. **Critical: explore `@aoagents/ao-core` exports.** Specifically:
   - `packages/core/src/index.ts` for public exports
   - `packages/core/src/session-manager.ts` for `SessionManager` interface (look at `spawn`, `get`, `kill`, `send`, `list`)
   - `packages/core/src/types.ts` for `Session`, `SessionStatus`, `ActivityState`, `SessionId`, `SessionSpawnConfig`
   - `loadConfig`, `createPluginRegistry`, `createSessionManager`, `createLifecycleManager` — how they wire together (search for usage in `packages/cli/`)
5. `CLAUDE.md` — repo conventions.

## Files to Create

1. **`packages/workflow/src/ao-client.ts`** — thin facade over `@aoagents/ao-core`. Engine never imports `ao-core` directly — only through this module.

   Exports:
   - `interface AoContext { sm: SessionManager; lm: LifecycleManager; config: OrchestratorConfig }` (re-export types you need from ao-core)
   - `createAoContext(projectId: string): Promise<AoContext>` — calls `loadConfig`, builds plugin registry, creates session manager + lifecycle manager
   - `spawnAgentSession(ctx: AoContext, opts: { projectId: string; agent: string; branch: string; prompt: string }): Promise<{ sessionId: SessionId; branch: string }>`
   - `getSessionStatus(ctx: AoContext, sessionId: SessionId): Promise<{ status: SessionStatus; activity: ActivityState; lastActivityAt: string | null }>`
   - `killSession(ctx: AoContext, sessionId: SessionId, reason?: string): Promise<void>`

   Notes:
   - Match what `packages/cli/src/commands/spawn.ts` does for initialization order — that's the canonical pattern.
   - If creating the AoContext is heavyweight (loads config, registers plugins), cache the context per projectId in a module-level Map.
   - Re-export the specific types the engine will need (`SessionId`, `SessionStatus`, `ActivityState`) so consumers don't import from ao-core directly.

2. **`packages/workflow/src/completion-detector.ts`** — per §4:
   - `waitForStepCompletion(opts: { ctx: AoContext; sessionId: SessionId; expectedOutputs: ArtifactRef[]; artifactsDir: string; timeoutMs: number; idleThresholdMs?: number; pollIntervalMs?: number }): Promise<CompletionResult>`
   - `type CompletionResult = { kind: "completed"; outputs: Array<{ path: string; hash: string }> } | { kind: "timeout"; reason: string } | { kind: "failed"; reason: string }`
   - Two-check contract:
     1. All declared output files exist at their declared paths inside artifactsDir
     2. Activity state is `idle` (per session.activity returning "idle" OR no activity for ≥ idleThresholdMs)
   - Poll interval default 10s; idleThresholdMs default 30000.
   - Loop:
     - `getSessionStatus` to read activity + status
     - If status is terminal (exited/terminated/done) without outputs present → return `failed` with reason
     - Check all expected outputs exist on disk (use `fs.access`)
     - If outputs exist AND activity has been "idle"/"ready" for at least idleThresholdMs → hash each output and return `completed`
     - If wall-clock exceeded timeoutMs → return `timeout`
     - Sleep pollIntervalMs and repeat
   - Use `fs/promises`. To hash, import from `./artifact-store` if Phase 1a has merged; otherwise implement inline (parallel safety: keep it self-contained for v1 — copy the hashing logic if `artifact-store.ts` doesn't exist yet on your branch).

3. **`packages/workflow/src/__tests__/ao-client.test.ts`** — at least 4 tests (mock `@aoagents/ao-core`):
   - `createAoContext` resolves and returns sm/lm/config
   - `spawnAgentSession` calls `sm.spawn` with correct args and returns sessionId
   - `getSessionStatus` maps ao-core Session to the simpler shape
   - `killSession` calls `sm.kill` with correct reason

4. **`packages/workflow/src/__tests__/completion-detector.test.ts`** — at least 6 tests with mock ao-client + mock fs:
   - Returns `completed` when all outputs exist AND activity is idle for ≥ threshold
   - Returns `timeout` when wall-clock exceeded before outputs appear
   - Returns `failed` when session reaches terminal status with outputs missing
   - Does NOT complete early when outputs exist but activity has been idle < threshold (waits)
   - Polls at the configured interval (count mock calls)
   - Resolves output hashes correctly on success

## Hard Constraints

- Modify ONLY `packages/workflow/`. Add the 4 files above plus minimal `errors.ts` additions (e.g., `AoContextError`, `CompletionTimeoutError`).
- ENGINE rule: only `ao-client.ts` imports from `@aoagents/ao-core`. No other file in the package should.
- Mocks must use vitest's `vi.mock` for `@aoagents/ao-core` — don't reach into ao-core internals.
- Strict TS, no `any`. Use the actual `SessionManager` / `LifecycleManager` interface from ao-core.
- Max 400 LOC per file.

## Acceptance — All Must Pass

```bash
pnpm --filter @aoagents/ao-workflow build
pnpm --filter @aoagents/ao-workflow test
pnpm typecheck
```

## When Done

1. Verify acceptance.
2. Commit: `feat(workflow): phase 1c — ao-client + completion-detector`
3. Push your branch.
4. PR: `gh pr create --base feature/workflow-engine --title 'feat(workflow): phase 1c — ao-client + completion-detector'`
5. PR body: files added, acceptance, note independent of 1a and 1b.

## Out of Scope

- Engine, selectors, prompt-template, artifact-store, state-store, approvals, CLI — other phases.
- Examples, README.
- Files outside `packages/workflow/`.
