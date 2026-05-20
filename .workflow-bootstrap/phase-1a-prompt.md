# Phase 1a — Artifact Store + State Store

## Required Reading

1. `docs/workflow-engine.md` — design spec. Read §5 (State Management), §9 (Module Responsibilities — artifact-store + state-store), §12 (Open Questions). Skim the rest.
2. `packages/workflow/src/types.ts` — types already defined in Phase 0. Reuse, don't redefine.
3. `packages/workflow/src/errors.ts` — extend with new error classes if needed.
4. `CLAUDE.md` — repo conventions.

## Files to Create

1. **`packages/workflow/src/artifact-store.ts`** — per §9:
   - `hashFile(absPath: string): Promise<string>` — sha256 hex
   - `resolveArtifactPath(artifactsDir: string, relPath: string): string` — joins, normalizes, validates path stays inside artifactsDir (prevent escape)
   - `copyArtifact(src: string, dest: string): Promise<{path: string, hash: string}>` — copies, returns dest path + hash
   - `verifyArtifact(absPath: string, expectedHash: string): Promise<boolean>`
   - `hashesEqual(a: string, b: string): boolean` — constant-time string compare via timingSafeEqual where lengths match
   - Use `node:fs/promises`, `node:crypto`, `node:path`.
   - Stream files for hashing (don't read entire file into memory) — use `crypto.createHash` + `fs.createReadStream`.

2. **`packages/workflow/src/state-store.ts`** — per §5 schema + §9 functions:
   - `loadRunState(runDir: string): Promise<RunState>` — reads state.json, validates via Zod (define schema inline or in schema.ts via export)
   - `saveRunState(runDir: string, state: RunState): Promise<void>` — atomic: write to `state.json.tmp` then `rename`
   - `updateStep(runDir: string, stepId: StepID, updater: (prev: StepState) => StepState): Promise<RunState>` — read-modify-write under a lock file (use `proper-lockfile` if available in deps, else implement a simple `.lock` with retry)
   - `createRunState(runDir: string, workflow: WorkflowDefinition, initialInputs: Artifact[]): Promise<RunState>` — builds initial state with all steps `pending`, writes state.json
   - All file ops via `node:fs/promises`. Atomic write: write tmp + rename (rename is atomic on POSIX).
   - Lock file: simple `.state.lock` with PID + timestamp; retry with exponential backoff up to ~2s; throw if still locked.

3. **`packages/workflow/src/__tests__/artifact-store.test.ts`** — at least 8 vitest tests:
   - Hash is stable across runs for same content
   - Hash differs for different content
   - resolveArtifactPath joins correctly; rejects `../escape`
   - copyArtifact creates dest, returns hash matching the source
   - verifyArtifact returns true for matching hash, false for mismatch
   - hashesEqual handles equal/non-equal/different-length

4. **`packages/workflow/src/__tests__/state-store.test.ts`** — at least 8 vitest tests:
   - createRunState produces initial state with all steps pending
   - loadRunState round-trips saveRunState
   - updateStep applies updater and persists
   - Atomic write: simulated crash (no tmp leak after rename)
   - Lock file: concurrent updateStep calls serialize correctly (spawn 2 promises, both succeed sequentially)
   - loadRunState throws on missing file or corrupt JSON

## Hard Constraints

- Modify ONLY `packages/workflow/`. Specifically: add the 4 files above plus minimal `errors.ts` additions (e.g., `StateStoreError`, `LockTimeoutError`). Don't touch any other file.
- No new top-level dependencies. If you need a locking primitive, implement it inline (~30 lines) — don't pull in `proper-lockfile`.
- All new code must pass strict TS — no `any`, no `as any`. Prefer `unknown` + narrowing.
- Reuse types from `packages/workflow/src/types.ts`. Do NOT redefine `RunState`, `StepState`, `Artifact`, etc.
- Max 400 LOC per file. Split if needed.

## Acceptance — All Must Pass

```bash
pnpm --filter @aoagents/ao-workflow build
pnpm --filter @aoagents/ao-workflow test
pnpm typecheck
```

## When Done

1. Verify all acceptance commands pass.
2. Commit: `feat(workflow): phase 1a — artifact-store + state-store`
3. Push your branch.
4. PR: `gh pr create --base feature/workflow-engine --title 'feat(workflow): phase 1a — artifact-store + state-store'`
5. PR body should list:
   - Files added
   - Confirmation that all acceptance commands pass
   - Note: independent of Phase 1b and 1c (no shared files)

## Out of Scope

- Engine, selectors, prompt-template, ao-client, completion-detector, approvals, CLI — those are other phases.
- Examples, README — later.
- Any file outside `packages/workflow/`.
