# Phase 3.2 — Workspace Setup Hook (Drop Resolver Into Every Worktree)

## Required Reading

1. `docs/workflow-engine.md` — especially §17.1 (the resolver script is invoked by agents from inside their own worktree) and §17.3 (the prompt footer that tells agents to call it — lands in 3.3, but explains why the script must be present).
2. **Existing modules** (read them before changing anything):
   - `packages/workflow/src/resolver/script.ts` — the script you must copy. Built to `dist/resolver/script.js` by 3.1.
   - `packages/workflow/src/ao-client.ts` — the **only** module that touches `@aoagents/ao-core`. You will add ONE helper here.
   - `packages/workflow/src/engine/step-runner.ts` — `runAgentStep` is where the new hook fires. Note the existing sequence: `spawnAgentSession` → `updateStep(running)` → `waitForStepCompletion` → `updateStep(completed)`. The new install step slots **after spawn returns, before completion polling starts**.
   - `packages/workflow/src/logger.ts` — for warn-on-failure (install failure is best-effort, not fatal).
3. `CLAUDE.md` — repo conventions.

## What This PR Delivers

After 3.1, the resolver script exists but no agent can reach it. This PR copies `dist/resolver/script.js` into every spawned agent's worktree at `<workspacePath>/.ao/aow-ref` immediately after spawn. From this PR forward, every AO session started by the workflow engine has the resolver tool reachable as `node .ao/aow-ref "<ref>"` (or `./.ao/aow-ref "<ref>"` because we `chmod +x` it).

No change to the prompt is made in this PR — agents won't know to call it yet. That's 3.3. This PR is the plumbing.

## Files to Create

1. **`packages/workflow/src/engine/workspace-setup.ts`**

   Exports:

   ```ts
   /** Absolute path to the built resolver script that ships with this package. */
   export function getBundledResolverScriptPath(): string;

   /**
    * Copy the bundled resolver script into `<workspacePath>/.ao/aow-ref`,
    * create the `.ao/` dir if missing, and chmod 0o755 on the destination.
    * Best-effort: throws WorkspaceSetupError on hard failure; the caller
    * decides whether to fail the step or log-and-continue.
    */
   export async function installResolverScript(workspacePath: string): Promise<void>;
   ```

   Implementation notes:
   - Resolve `getBundledResolverScriptPath()` via `import.meta.url`. Compute it as
     `fileURLToPath(new URL("../resolver/script.js", import.meta.url))`. After build, this resolves to `dist/resolver/script.js` next to the compiled `workspace-setup.js`.
   - Validate that the resolved path exists (`fs.access`); if not, throw `WorkspaceSetupError("bundled resolver script missing at <path> — did you build?")`.
   - Validate that `workspacePath` is an absolute path; if not, throw.
   - Use `fs.mkdir(workspaceDotAo, { recursive: true })`, then `fs.copyFile(source, dest)`, then `fs.chmod(dest, 0o755)`.
   - Keep under 80 LOC.

2. **`packages/workflow/src/__tests__/engine/workspace-setup.test.ts`**

   - At least 5 tests:
     - `installResolverScript` creates `.ao/aow-ref` inside the given workspace.
     - The destination file is executable (`mode & 0o111`).
     - The destination file content equals the source script byte-for-byte.
     - Calling `installResolverScript` twice does not error (idempotent — overwrite).
     - Throws `WorkspaceSetupError` when given a relative path.
   - Use `fs.mkdtemp(os.tmpdir() + "/aow-ws-")` for the workspace, clean up in `afterEach`.
   - To test against the built script, depend on `pnpm --filter @aoagents/ao-workflow build` having run first. Vitest will read the path via the same `import.meta.url` resolution; if the dist file is missing, fail loudly with a clear message instead of silently skipping.

## Files to Modify

1. **`packages/workflow/src/ao-client.ts`** — add a new helper near the bottom:

   ```ts
   /**
    * Look up a session's filesystem workspace path. Returns null if the
    * session no longer exists. Used by the workflow engine to drop the
    * resolver script into the agent's worktree post-spawn.
    */
   export async function getSessionWorkspacePath(
     ctx: AoContext,
     sessionId: SessionId,
   ): Promise<string | null> {
     const session = await ctx.sm.get(sessionId);
     if (!session) return null;
     return session.workspacePath ?? null;
   }
   ```

   Do NOT change anything else in this file.

2. **`packages/workflow/src/engine/step-runner.ts`** — inside `runAgentStep`, in the success branch of `spawnAgentSession` (after `sessionId = spawn.sessionId;` and BEFORE the `timeoutMs` calculation), add:

   ```ts
   try {
     const workspacePath = await getSessionWorkspacePath(ctx.aoCtx, sessionId);
     if (workspacePath) {
       await installResolverScript(workspacePath);
     } else {
       log.warn(`[${step.id}] could not locate workspace for session ${sessionId}; resolver script not installed`);
     }
   } catch (err) {
     // Best-effort: do not fail the step if the resolver script can't be installed.
     // The agent will simply not have access to the .ao/aow-ref tool for this run.
     const reason = err instanceof Error ? err.message : String(err);
     log.warn(`[${step.id}] failed to install resolver script: ${reason}`);
   }
   ```

   Add the necessary imports at the top of the file:
   ```ts
   import { getSessionWorkspacePath } from "../ao-client.js";
   import { installResolverScript } from "./workspace-setup.js";
   ```

   Do NOT change any other behavior of `runAgentStep`.

3. **`packages/workflow/src/errors.ts`** — add at the end (and extend the `WorkflowErrorCode` union with `| "WF_WORKSPACE_SETUP"`):

   ```ts
   export class WorkspaceSetupError extends WorkflowError {
     constructor(message: string, options?: ErrorOptions) {
       super("WF_WORKSPACE_SETUP", message, options);
       this.name = "WorkspaceSetupError";
     }
   }
   ```

4. **`packages/workflow/src/index.ts`** — re-export `getSessionWorkspacePath` and `installResolverScript` for library consumers.

5. **`packages/workflow/package.json`** — confirm the `"files"` array already includes `"dist"` (it does). No change needed. But verify after build that `dist/resolver/script.js` and `dist/engine/workspace-setup.js` both exist; if the second is missing, `tsconfig` is not picking up the new file — fix by checking `tsconfig.json` `include`/`exclude` patterns.

## Update the Existing Integration Test

`packages/workflow/src/__tests__/engine.integration.test.ts` already mocks `@aoagents/ao-core`. Extend the mock so:

- The mocked `sm.get(sessionId)` returns a `Session` object with `workspacePath` set to a tmp dir created in `beforeEach` (e.g. `fs.mkdtemp(os.tmpdir() + "/aow-int-")`).
- After the agent step runs in the existing happy-path test, assert that `<workspacePath>/.ao/aow-ref` exists and is executable.
- Add ONE new test: when `sm.get()` returns `null` (session disappeared between spawn and lookup), the step still completes successfully — the install failure is logged but does not fail the workflow.

Do NOT rewrite the existing tests — extend them.

## Hard Constraints

- Modify ONLY `packages/workflow/`.
- DO NOT import from `@aoagents/ao-core` anywhere outside `ao-client.ts`. The new `workspace-setup.ts` lives under `engine/` and uses only `node:fs/promises`, `node:path`, `node:url`.
- DO NOT modify the resolver script or schema from 3.1.
- Install failure is **best-effort**. The step must NOT be marked failed because the resolver couldn't be copied. Log a warning and continue — the agent will run without the tool, the linter (3.4) will catch any citation issues on its own.
- Strict TS. No `any`.
- Max 80 LOC for `workspace-setup.ts`. The step-runner change is ~15 LOC.

## Why Best-Effort?

If we hard-fail on install errors, a permission glitch on the worktree dir would kill every step. The resolver is a **convenience tool** for the agent; the linter is the actual enforcement mechanism (3.4). Missing resolver script = agent can't traverse citations on demand, but the linter still catches bad citations post-step. Graceful degradation.

## Acceptance — All Must Pass

```bash
pnpm --filter @aoagents/ao-workflow build
pnpm --filter @aoagents/ao-workflow test    # workspace-setup tests + extended integration test
pnpm typecheck                              # whole repo

# Manual smoke (document in PR body):
# 1. Run a workflow against a real (or stubbed) AO project.
# 2. Find a spawned session's workspace path: ls ~/.agent-orchestrator/<hash>/worktrees/<sessionId>/.ao/
# 3. Confirm `aow-ref` exists, is executable, and runs:
node ~/.agent-orchestrator/<hash>/worktrees/<sessionId>/.ao/aow-ref "<some-test-ref>"
```

## When Done

1. Verify all acceptance.
2. Commit: `feat(workflow): phase 3.2 — workspace setup hook for resolver script`
3. Push.
4. `gh pr create --base feature/workflow-engine --title 'feat(workflow): phase 3.2 — workspace setup hook for resolver script'`
5. PR body should:
   - List files added / modified
   - Confirm acceptance commands pass
   - State explicitly: "the agent does not yet know to call the resolver — that contract lands in 3.3. This PR is plumbing only."

## Out of Scope (DO NOT DO IN THIS PR)

- Prompt contract footer extension — 3.3.
- Citation linter — 3.4.
- `aow show --hops` — 3.5.
- Any change to the resolver script or schema (3.1 owns those).
- Any change to `StepState`, `AttemptRecord`, `state-store.ts`, `prompt-template.ts`, `cli.ts`, `completion-detector.ts`.
- Adding the resolver script to non-agent steps (approval gates don't need it).
- Any change outside `packages/workflow/`.
