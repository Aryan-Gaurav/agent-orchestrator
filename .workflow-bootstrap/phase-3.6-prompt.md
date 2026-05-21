# Phase 3.6 — Standalone `aow` (Local Only, Not Published)

## Why

`aow` currently only works inside the agent-orchestrator monorepo checkout. We want it to run from any local repo using the AO version already in this monorepo — **no npm publish yet**. Four things have to change:

1. `aow` must be **packaged as its own sub-package** (`packages/aow/`) so it has a clean bin entry that resolves plugins from its own `node_modules`. Local-only for now — tested via `node packages/aow/bin/aow.js …` from any cwd. Publish config is set up so a human can `pnpm publish` later, but this phase does not publish.
2. The package must **carry plugin deps** (via `workspace:*`) so plugins resolve from its own `node_modules` instead of failing with "Runtime plugin 'tmux' not found".
3. `aow run` in a fresh repo must **auto-create** a minimal `agent-orchestrator.yaml` (the way `ao start` does).
4. `aow run` must **auto-start the AO daemon** if it isn't already running (or, if that's too invasive, fail with a precise instructional error).

This phase delivers all four. Phase 3.7 dogfoods it on a real workflow (URL shortener).

## Required Reading

1. `packages/cli/package.json` — the working dep pattern. `aow` mirrors its plugin set.
2. `packages/ao/package.json` and `packages/ao/bin/ao.js` — the "global wrapper" pattern (`@aoagents/ao` is a thin shim around `@aoagents/ao-cli`). `aow` will use the same shape.
3. `packages/cli/dist/commands/start.js` lines 450–460 and around — how `ao start` writes the first-run `agent-orchestrator.yaml`. The behavior you mirror.
4. `packages/cli/src/commands/start.ts` (and dist equivalent) — how `ao start` starts the lifecycle daemon. You'll either call into this or shell out to `ao start`.
5. `packages/workflow/package.json` and `packages/workflow/src/cli.ts` — the current state, what you modify.
6. `packages/workflow/src/ao-client.ts` lines 56–110 — where plugin loading happens, and where a "daemon not running" check would slot in.
7. `~/.agent-orchestrator/running.json` — the lockfile written by `ao start` (pid + port + projects). You read this to detect "is AO running."
8. `CLAUDE.md` — repo conventions.

## Files to Create / Modify

### 1. `packages/workflow/package.json` (MODIFY)

Add to `dependencies` (alphabetical, after `@aoagents/ao-core`):

```json
"@aoagents/ao-plugin-agent-aider": "workspace:*",
"@aoagents/ao-plugin-agent-claude-code": "workspace:*",
"@aoagents/ao-plugin-agent-codex": "workspace:*",
"@aoagents/ao-plugin-agent-cursor": "workspace:*",
"@aoagents/ao-plugin-agent-kimicode": "workspace:*",
"@aoagents/ao-plugin-agent-opencode": "workspace:*",
"@aoagents/ao-plugin-notifier-composio": "workspace:*",
"@aoagents/ao-plugin-notifier-dashboard": "workspace:*",
"@aoagents/ao-plugin-notifier-desktop": "workspace:*",
"@aoagents/ao-plugin-notifier-discord": "workspace:*",
"@aoagents/ao-plugin-notifier-openclaw": "workspace:*",
"@aoagents/ao-plugin-notifier-slack": "workspace:*",
"@aoagents/ao-plugin-notifier-webhook": "workspace:*",
"@aoagents/ao-plugin-runtime-process": "workspace:*",
"@aoagents/ao-plugin-runtime-tmux": "workspace:*",
"@aoagents/ao-plugin-scm-github": "workspace:*",
"@aoagents/ao-plugin-scm-gitlab": "workspace:*",
"@aoagents/ao-plugin-tracker-github": "workspace:*",
"@aoagents/ao-plugin-tracker-gitlab": "workspace:*",
"@aoagents/ao-plugin-tracker-linear": "workspace:*",
"@aoagents/ao-plugin-workspace-clone": "workspace:*",
"@aoagents/ao-plugin-workspace-worktree": "workspace:*"
```

Do NOT include `terminal-*` plugins — `aow` does not open terminal panes.

After editing, `pnpm install` at the monorepo root to materialize symlinks.

### 2. `packages/aow/` (NEW PACKAGE — global wrapper, mirrors `packages/ao/`)

Create a new sub-package that's the publishable "global `aow`". It's a thin shim — same shape as `packages/ao/`.

Files:

- `packages/aow/package.json`:
  ```json
  {
    "name": "@aoagents/aow",
    "version": "0.0.1",
    "description": "Workflow engine for agent-orchestrator — global CLI wrapper",
    "license": "MIT",
    "type": "module",
    "bin": { "aow": "bin/aow.js" },
    "files": ["bin"],
    "dependencies": {
      "@aoagents/ao-workflow": "workspace:*"
    },
    "engines": { "node": ">=20.0.0" },
    "publishConfig": { "access": "public", "provenance": true }
  }
  ```
- `packages/aow/bin/aow.js`:
  ```js
  #!/usr/bin/env node
  import { fileURLToPath } from "node:url";
  import { dirname, resolve } from "node:path";
  import { spawn } from "node:child_process";

  const here = dirname(fileURLToPath(import.meta.url));
  // resolves to dist/cli.js inside the @aoagents/ao-workflow dep
  const cliEntry = resolve(here, "..", "node_modules", "@aoagents/ao-workflow", "dist", "cli.js");

  const child = spawn(process.execPath, [cliEntry, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  ```
- Make the bin executable in the build (`chmod +x` is fine; `prepublishOnly` script can `chmod` if needed).

Add `packages/aow/` to the monorepo's `pnpm-workspace.yaml` if it isn't auto-discovered (it should be).

### 3. `packages/workflow/src/cli/bootstrap.ts` (NEW, ≤ 100 LOC)

Auto-create `agent-orchestrator.yaml` if missing.

Public surface:

```ts
export interface BootstrapResult {
  configPath: string;
  projectId: string;
  created: boolean;
}

/**
 * If `agent-orchestrator.yaml` (or `.yml`) exists in `cwd`, return its path
 * and the first project's id. Otherwise, write a minimal flat config and
 * return it.
 *
 * Minimal config (flat):
 *   $schema: https://raw.githubusercontent.com/ComposioHQ/agent-orchestrator/main/schema/config.schema.json
 *   name: <basename of cwd>
 *   path: <cwd>
 *   defaultBranch: main
 *   sessionPrefix: aow
 *   agent: claude-code
 *   workspace: worktree
 */
export async function ensureAowConfig(cwd: string): Promise<BootstrapResult>;
```

Implementation rules:
- `node:fs/promises` + `node:path` only.
- Atomic write: `.tmp` then `rename`.
- ProjectId sanitization: lowercase, `[^a-zA-Z0-9_-]` → `_`, trim trailing `_`.
- For existing wrapped config (`projects:` block), return the first key under `projects:`.
- Throw `WorkflowError` with a clear message on any fs failure.

### 4. `packages/workflow/src/cli/daemon-check.ts` (NEW, ≤ 60 LOC)

Detect / auto-start the AO daemon.

Public surface:

```ts
export interface DaemonStatus {
  running: boolean;
  pid?: number;
  port?: number;
  projects?: string[];
}

/** Read ~/.agent-orchestrator/running.json. Returns running=false if missing or pid is dead. */
export async function getDaemonStatus(): Promise<DaemonStatus>;

/**
 * If daemon not running, attempt to start it by shelling out to `ao start`
 * (background-detached). Returns true if started or already running. Throws
 * with a clear message if neither possible (e.g. `ao` not on PATH).
 */
export async function ensureDaemonRunning(): Promise<boolean>;
```

Implementation rules:
- `getDaemonStatus`: read `~/.agent-orchestrator/running.json`. If file missing → `{ running: false }`. If file present, `process.kill(pid, 0)` to check liveness; if it throws ESRCH → `{ running: false }`. Otherwise return parsed.
- `ensureDaemonRunning`: if `getDaemonStatus().running === true`, return true. Else: spawn `ao start --no-dashboard` via `child_process.spawn` with `detached: true, stdio: 'ignore'`, `unref()` so the parent process can exit. Poll `getDaemonStatus()` up to 10 seconds for the daemon to register. If `ao` is not on PATH, throw `WorkflowError("AO daemon is not running and 'ao' CLI was not found. Run 'npm install -g @aoagents/ao' or start the daemon manually.")`.

### 5. `packages/workflow/src/cli.ts` (MODIFY)

In the `run` command handler, BEFORE any state-store or engine call:

1. `const bootstrap = await ensureAowConfig(process.cwd());`
2. If `bootstrap.created`, log `"Created agent-orchestrator.yaml at <path> — registered project <projectId>."`
3. `await ensureDaemonRunning();` — auto-starts AO if needed.
4. Continue to existing flow.

Do NOT change `show`, `resume`, `approve`, `reject`, `status`, `list`.

### 6. `packages/workflow/src/__tests__/cli/bootstrap.test.ts` (NEW)

Min 5 tests:
1. Fresh dir, no yaml → `created === true`; file written; parses cleanly; has required fields.
2. Dir with flat config → `created === false`; returns existing `name`.
3. Dir with wrapped config → `created === false`; returns first project key.
4. Cwd with special chars in basename → projectId sanitized correctly.
5. Concurrent `Promise.all([...])` on fresh dir → no double-write; one creates, one detects.

### 7. `packages/workflow/src/__tests__/cli/daemon-check.test.ts` (NEW)

Min 4 tests:
1. No `running.json` → `getDaemonStatus().running === false`.
2. Stale `running.json` (pid that's gone) → `running === false`.
3. Live pid (use the test process's own pid as a stand-in) → `running === true`.
4. `ensureDaemonRunning()` when daemon already running → returns true without spawning.

(Do NOT test the actual `ao start` spawn in unit tests — too flaky. Mock by stubbing `child_process.spawn` for that path or skip it; cover via the smoke test below.)

### 8. `packages/workflow/src/index.ts` (MODIFY)

Export `ensureAowConfig`, `BootstrapResult`, `getDaemonStatus`, `ensureDaemonRunning`, `DaemonStatus`. Nothing else.

## Hard Constraints

- Modify ONLY the files listed (new test files and fixtures allowed). No edits to `engine.ts`, `step-runner.ts`, `resolver/*`, `citation-linter*`, or any existing plugin package.
- Strict TS, no `any`.
- No new top-level dependencies. `node:*` only.
- Per-file LOC cap: 400 (hard). Bootstrap ≤ 100; daemon-check ≤ 60.
- `ensureDaemonRunning` must NEVER block the parent process. `unref()` the child.
- The new `packages/aow/` package must build cleanly under the existing monorepo build (`pnpm build` at root).

## Acceptance (run and paste in PR body)

```bash
pnpm install
pnpm build                          # builds the whole monorepo including new packages/aow
pnpm --filter @aoagents/ao-workflow test
pnpm --filter @aoagents/ao-workflow typecheck
```

All pass. Test count increases by ≥ 9 (5 bootstrap + 4 daemon-check).

**Smoke test in PR notes:**

```bash
# In a fresh terminal, with NO `ao start` already running:
mkdir /tmp/aow-smoke && cd /tmp/aow-smoke && git init -q
cat > workflow.yaml <<EOF
id: smoke
artifacts_dir: ./artifacts
project_id: aow-smoke
steps:
  - id: hello
    type: agent
    agent: claude-code
    prompt: "Say hi in hello.txt"
    outputs:
      out: hello.txt
EOF

# From the published-style wrapper:
node /path/to/agent-orchestrator/packages/aow/bin/aow.js run workflow.yaml 2>&1 | head -20
```

Paste the output. Must show:
- `"Created agent-orchestrator.yaml at ..."` (bootstrap fired)
- Daemon either already running, or autostart message, or a clear error if `ao` isn't on PATH
- No `"Runtime plugin 'tmux' not found"` error

## When Done

1. Branch off `feature/workflow-engine`.
2. PR title: `feat(workflow): phase 3.5.1 — aow parity with ao (plugins, bootstrap, autostart, global wrapper)`
3. PR body matching prior phase format: Summary, Files Added (`packages/aow/*`, bootstrap.ts, daemon-check.ts, tests), Files Modified (workflow package.json, cli.ts, index.ts), Acceptance (4 commands), Smoke (the /tmp/aow-smoke run), Notes, Test plan checklist.

## Out of Scope

- Phase 3.6 (URL-shortener dogfood) — runs after this lands.
- Actually publishing to npm. The package is set up for it (`publishConfig`); the human runs `pnpm publish` when ready.
- Auto-installing `@aoagents/ao` when `ao` is not on PATH. Just throw the helpful error.
- Migrating wrapped configs to flat. Bootstrap only writes new flat configs.
- Adding a `--no-bootstrap` or `--no-autostart` opt-out. Default-on is the right UX.
