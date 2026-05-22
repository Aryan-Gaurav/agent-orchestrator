# Phase 3.7 — `aow` Dogfood Test (URL Shortener E2E)

## Why

Phase 3.6 made `aow` work standalone. Phase 3.7 proves it by running a real, multi-step workflow end-to-end on the URL-shortener fixture and reporting what worked, what broke, and where the seams hurt.

This is **not** a Phase that opens a PR with code changes to `packages/workflow/` or `packages/aow/`. It's a verification + findings report. Any bugs surfaced become follow-up PRs.

## The fixture

Already prepared at `~/aow-test-url-shortener/`:

- `requirements.md` — functional + non-functional requirements for a consistent-hashing URL shortener.
- `workflow.yaml` — 4 sequential agent steps:
  1. `design` — produce `design.md` (hash function, ring, replication, encoding, etc.)
  2. `hld` — produce `hld.md` from `design.md` + requirements
  3. `impl` — produce `package.json`, `tsconfig.json`, `src/{HashRing,KVStore,Shortener,HttpServer,index}.ts`
  4. `tests` — produce vitest tests for HashRing, Shortener, and an e2e HTTP test
- `agent-orchestrator.yaml` — flat config, registered globally as `aow-test-url-shortener_aa35433bbb`.

Each step:
- Has explicit `inputs:` and `outputs:` so artifacts are content-addressed.
- Has a detailed prompt with required sections.
- Enforces the citation contract (`<!-- ref: ... -->` for markdown, `// ref: ...` for code).
- Caps each file at 200-400 LOC.

## What to do

1. **Wipe prior state** (a prior failed run exists):
   ```bash
   rm -rf ~/aow-test-url-shortener/.workflow-state ~/aow-test-url-shortener/artifacts
   ```

2. **Kick off the run** from this repo (not the fixture dir):
   ```bash
   cd ~/aow-test-url-shortener
   node /Users/aryangaurav/agent-orchestrator/packages/aow/bin/aow.js run workflow.yaml
   ```

3. **Watch progress** in a separate terminal:
   ```bash
   node /Users/aryangaurav/agent-orchestrator/packages/aow/bin/aow.js status
   tmux ls   # see ust-* sessions
   ```

4. **Let each step complete** (each agent step may take 5-15 minutes). If a step is `human_approval` (none in this workflow, but if added) approve from a separate terminal. If a step fails, capture the error and decide whether to retry or escalate.

5. **Verify outputs**:
   - `~/aow-test-url-shortener/artifacts/design.md` exists, has all required sections
   - `~/aow-test-url-shortener/artifacts/hld.md` exists, cites design.md properly
   - `~/aow-test-url-shortener/artifacts/src/*.ts` compiles (`pnpm build` inside the fixture dir)
   - Tests pass: `pnpm test` inside the fixture dir
   - The HTTP server boots on port 8080 and responds: `node src/index.js & curl -X POST -d '{"url":"https://example.com"}' http://localhost:8080/shorten`

6. **Write the findings report** at `~/agent-orchestrator/docs/aow-dogfood-findings.md`:
   - **Top-of-file metrics table** — one row per step:
     | step | attempts | wall time | tokens (approx) | first-pass success | citation issues | manual edits needed |
   - **What worked** — bullet list. Bootstrap UX, plugin resolution, completion detection, citation lint, etc.
   - **What broke** — bullet list with specific errors, file paths, line numbers if applicable. For each: severity (blocker / annoying / nit) and whether it should be a follow-up PR.
   - **Friction points** — UX gaps. Things that worked but felt wrong. Missing flags, confusing error messages, slow polls, etc.
   - **The verdict** — would you ship this to an external dogfood user? One sentence + reasoning.

## Hard constraints

- **No code changes to `packages/workflow/` or `packages/aow/`** in this phase. Findings only.
- **No new PRs from worker sessions.** The agent steps inside the workflow open their own PRs to the fixture repo (which has no remote — they stay local), but the orchestrator does not open a PR to `feature/workflow-engine` for this phase. After findings are written, the human commits + pushes the report.
- **Do not edit the workflow.yaml fixture** unless it's literally broken. Document any issues you wanted to fix as findings.
- **Strict TS, citation contract enforced** — these are the workflow's own enforcement; if they fail in the wild, that's a finding worth recording.

## Acceptance

- The run completes (all 4 steps succeed) OR a clear blocker is documented in findings.
- Findings file is committed to `feature/workflow-engine` under `docs/aow-dogfood-findings.md`.
- The metrics table is filled in completely (no `?` cells).

## When done

1. Verify findings file exists and is non-trivial.
2. Commit: `docs(workflow): phase 3.7 — aow dogfood findings`
3. Push to `feature/workflow-engine`.
4. No PR needed — the human reviews and merges directly. (Findings is not gated by AO reactions.)
5. Idle. Phase 3 is complete after this; further phases are scoped separately.

## Out of scope

- Fixing any bugs surfaced. Each bug is a separate follow-up PR.
- Publishing `@aoagents/aow` to npm.
- Extending the workflow to add more steps.
- Running on any fixture other than `~/aow-test-url-shortener/`.
