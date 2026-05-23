# `aow` — Hello World: a URL Shortener, end-to-end

This walkthrough builds something real with `aow` so you can see the engine work. It's the same fixture we use to dogfood the engine ourselves: a 4-step workflow that takes a `requirements.md` and produces a working TypeScript URL shortener with tests.

If you just want to know what `aow` is, read [`aow-guide.md`](./aow-guide.md) first. This doc assumes you've read that and want to see an end-to-end run.

---

## What we're building

A horizontally-scalable URL shortener with consistent hashing. Four steps, each an AI coding agent gated by a citation linter:

```
requirements.md
      │
      ▼
┌───────────┐    ┌───────────┐    ┌───────────┐    ┌───────────┐
│  design   │───▶│    hld    │───▶│   impl    │───▶│   tests   │
└───────────┘    └───────────┘    └───────────┘    └───────────┘
   design.md       hld.md         src/*.ts          __tests__/*.ts
```

Each step:

- Reads the previous step's output as a typed `inputs:` map.
- Writes a fixed set of `outputs:` files (the engine waits for all of them).
- Must cite every load-bearing claim back to an upstream file. The citation linter blocks completion on unresolved refs.

The point: by the time you reach `tests`, the test file can cite `src/Shortener.ts` which cites `hld.md#modules` which cites `design.md#id-generation-and-collisions` which cites `requirements.md#functional-requirements`. The chain is mechanically verifiable.

---

## Layout

```
~/aow-test-url-shortener/
├── agent-orchestrator.yaml    # AO project config (auto-generated on first run)
├── requirements.md            # the input — written by hand
├── workflow.yaml              # the 4-step spec
└── artifacts/                 # everything the agents produce lands here
    ├── design.md
    ├── hld.md
    ├── package.json
    ├── tsconfig.json
    ├── src/
    │   ├── HashRing.ts
    │   ├── KVStore.ts
    │   ├── Shortener.ts
    │   ├── HttpServer.ts
    │   └── index.ts
    └── __tests__/
        ├── HashRing.test.ts
        ├── Shortener.test.ts
        └── e2e.test.ts
```

`requirements.md` and `workflow.yaml` are the only files you write. Everything else is produced.

---

## The input: `requirements.md`

Keep it short — this is the contract the whole workflow cites against.

```markdown
# URL Shortener — Requirements

## Functional requirements
- `POST /shorten { url }` returns `{ code, short_url }`.
- `GET /:code` 302-redirects; 404 if not found.
- Codes: 7 chars, base62 (`[A-Za-z0-9]`).
- Shard data via **consistent hashing** so adding/removing a shard moves a small fraction of keys.
- Storage behind an interface (in-memory v1, swappable for Redis later).

## Non-functional
- Single Node.js process for v1.
- No deps beyond `vitest`. Use Node built-ins.
- Strict TypeScript, no `any`.

## Out of scope
- Auth, rate limiting, analytics.
- Persistence (memory only).
- Distributed deployment (single process, but hash ring + shard interface must be the seam where distribution would slot in).
```

Headings matter — they become anchor IDs (`#functional-requirements`, `#out-of-scope`) the agents will cite.

---

## The workflow: `workflow.yaml`

The full file is in [`packages/workflow/examples/url-shortener/`](../packages/workflow/examples/) (or, in the dogfood checkout, at `~/aow-test-url-shortener/workflow.yaml`). The structure:

```yaml
id: url-shortener-build
description: Design and build a consistent-hashing URL shortener end-to-end.
artifacts_dir: ./artifacts
project_id: aow-test-url-shortener

steps:
  - id: design
    type: agent
    agent: claude-code
    inputs:
      requirements: ../requirements.md
    outputs:
      design: design.md
    prompt: |
      Read requirements.md. Write design.md — required sections:
      ## Hash Function    ## Ring and Virtual Nodes    ## Replication
      ## Shortcode Encoding    ## ID Generation and Collisions
      ## Storage Interface

      Cite requirements.md for every constraint. Format:
      `<!-- ref: requirements.md#functional-requirements claim="..." -->`

  - id: hld
    type: agent
    agent: claude-code
    depends_on: [design]
    inputs:
      requirements: ../requirements.md
      design: design.md
    outputs:
      hld: hld.md
    prompt: |
      Write hld.md — required sections: ## Modules  ## Data Flow  ## Error Modes
      Cite design.md for algorithm choices; requirements.md for non-functional constraints.

  - id: impl
    type: agent
    agent: claude-code
    depends_on: [hld]
    inputs:
      requirements: ../requirements.md
      design: design.md
      hld: hld.md
    outputs:
      package: package.json
      tsconfig: tsconfig.json
      hash_ring: src/HashRing.ts
      kv_store: src/KVStore.ts
      shortener: src/Shortener.ts
      server: src/HttpServer.ts
      entry: src/index.ts
    prompt: |
      Implement the URL shortener. Cite hld.md for module boundaries,
      design.md for algorithm choices. Per-file LOC cap: 200.

  - id: tests
    type: agent
    agent: claude-code
    depends_on: [impl]
    inputs:
      requirements: ../requirements.md
      hld: hld.md
      shortener_src: src/Shortener.ts
      # ...
    outputs:
      hash_ring_test: __tests__/HashRing.test.ts
      shortener_test: __tests__/Shortener.test.ts
      e2e_test: __tests__/e2e.test.ts
    prompt: |
      Write vitest tests. Cite the impl files for what's exercised,
      requirements.md for the spec being verified.
```

### Things to notice

- **`inputs` paths are relative to the workflow file.** `../requirements.md` walks up one level. Downstream steps read sibling artifacts by their logical name (`design`, `hld`) — those resolve via the `artifacts_dir`.
- **`outputs` is a contract.** The engine considers a step done only when every output file exists *and* the agent has been idle ≥30s. Missing one output → step keeps waiting until timeout.
- **`depends_on` chains the DAG.** Default is "previous step in the list," so the explicit `depends_on: [hld]` on `impl` is redundant but documents intent.
- **The prompt is the actual prompt** sent to the agent — no hidden middleware. The citation contract is enforced *after* the step runs by the linter.

---

## Running it

```bash
# One-time: nothing. aow bootstraps agent-orchestrator.yaml and starts the daemon
# on first invocation.

cd ~/aow-test-url-shortener
node /path/to/agent-orchestrator/packages/aow/bin/aow.js run workflow.yaml
```

> **Heads-up: skip the trust prompt.** Claude Code shows a "Do you trust this folder?" prompt the first time it spawns into a worktree of a fresh repo, and `aow` has no way to answer it. Add this to your `agent-orchestrator.yaml` before the first run:
>
> ```yaml
> agentConfig:
>   permissions: permissionless
> ```
>
> This makes `aow` pass `--dangerously-skip-permissions` on every spawn — the trust prompt (and per-tool prompts) are bypassed. See `docs/aow-guide.md` §2.1.

On first run you'll see:

```
info  started run wf-url-shortener-build-20260522T044835
info  steps to run: design, hld, impl, tests
step  [design] spawning agent=claude-code branch=aow-url-shortener-build-design-1-wf-url-shortener-build-20260522T044835 attempt=1
```

The branch name encodes: workflow id, step id, attempt number, run id. Each agent gets its own git worktree (visible in the dashboard at http://localhost:3000).

While it runs, in another terminal:

```bash
node /path/to/agent-orchestrator/packages/aow/bin/aow.js status
# Lists steps + their statuses

node /path/to/agent-orchestrator/packages/aow/bin/aow.js show <run-id> --step design
# Full state of one step: session, attempts, lint report
```

---

## What actually happens — annotated run log

This is from a real dogfood run on 2026-05-22 (run id `wf-url-shortener-build-20260522T044835`). Comments explain what the engine was doing at each point.

```
info  started run wf-url-shortener-build-20260522T044835
info  steps to run: design, hld, impl, tests

# Step 1: design. Agent spawned on a fresh worktree.
step  [design] spawning agent=claude-code branch=…-design-1-… attempt=1
# Agent ran for ~80s, wrote design.md.
# Citation linter found one slug mismatch ("out-of-scope" mis-cited).
error [design] citation lint errors (1):
error   - [claim_mismatch] design.md:requirements.md#out-of-scope — …
# Engine revised: killed the failed session, spawned attempt 2 with feedback.
warn  [design] citation lint failed: 1 error(s); revising (attempt 1/3)
step  [design] spawning agent=claude-code branch=…-design-2-… attempt=2
warn  [design] citation lint warnings: 6        # soft warnings — non-blocking
ok    [design] completed; outputs=1

# Step 2: hld. Same pattern — needed 3 attempts to clear lint.
step  [hld] spawning agent=claude-code branch=…-hld-1-… attempt=1
error [hld] citation lint errors (2): …
warn  [hld] revising (attempt 1/3)
step  [hld] spawning agent=claude-code branch=…-hld-2-… attempt=2
error [hld] citation lint errors (4): …
warn  [hld] revising (attempt 2/3)
step  [hld] spawning agent=claude-code branch=…-hld-3-… attempt=3
warn  [hld] citation lint warnings: 8
ok    [hld] completed; outputs=1

# Step 3: impl. 7 output files in one step.
step  [impl] spawning agent=claude-code branch=…-impl-1-… attempt=1
error [impl] citation lint errors (1):
error   - [claim_mismatch] src/Shortener.ts:hld.md#modules — …
warn  [impl] revising (attempt 1/3)
step  [impl] spawning agent=claude-code branch=…-impl-2-… attempt=2
ok    [impl] completed; outputs=7

# Step 4: tests. Runs against the produced src/.
step  [tests] spawning agent=claude-code branch=…-tests-1-… attempt=1
```

### What the engine handled for you

| Engine behavior | Why it matters |
|---|---|
| Branch per attempt with run-id suffix | Two runs can coexist without git worktree collisions |
| Killed prior session before each revision | No zombie tmux sessions piling up (4 steps × 3 attempts could leave 12 dead sessions otherwise) |
| Citation linter blocked completion | The agent can't lie about which constraint it implemented — every claim is verified against an actual upstream heading |
| Revision loop with feedback | Lint errors are injected into the next attempt's prompt automatically |
| Output-file gate | Step only completes when all declared outputs exist *and* agent has been idle 30s |
| Spawn race tolerance | Engine waits for the agent to transition past `spawning` before declaring it dead — no false-fails on slow PTY attaches |

### What you'd have done manually without `aow`

For each step, you would: write the prompt, spawn the agent (via `ao spawn`), watch the terminal, verify outputs exist, manually check citations, copy outputs to a known location, then start the next step with the right inputs. Multiply by 4 steps × 1–3 revisions per step. `aow` turns that into one command.

---

## State you can poke at

```
.workflow-state/runs/wf-url-shortener-build-20260522T044835/
├── definition.yaml      # snapshot of workflow.yaml pinned at run start
├── state.json           # per-step status, attempts, lint reports, hashes
├── feedback/            # rejection feedback that got injected into prompts
│   ├── design-attempt-2.md
│   ├── hld-attempt-2.md
│   ├── hld-attempt-3.md
│   └── impl-attempt-2.md
├── pending/             # active human_approval gates (this workflow has none)
└── artifacts/           # hashed copies of every output
```

`state.json` is human-readable. The full lint report for any failed attempt lives at `steps.<id>.history[N].lint_report` — useful when an error message in the log is too terse.

---

## Where it fails (be honest)

This workflow has no `human_approval` gates. That's intentional for a "watch it run end-to-end" demo. In real use:

- Insert a `human_approval` step after `design` so you can sanity-check the design doc before committing to an HLD.
- Set `max_revisions: 5` on `impl` if you want more leeway for lint loops on complex code.
- For larger workflows, the 4-hop citation depth cap will start surfacing warnings — that's a signal to split the workflow, not to disable the check.

The engine is sequential — fan-out is not supported in v1. If you need two designs in parallel, run two `aow run --only design` invocations into different artifacts dirs.

---

## Building your own

Copy this fixture as a starting point:

1. Write a `requirements.md` with the headings you want cited (keep it under 100 lines).
2. Sketch the steps you'd take by hand: design → review → implement → test, or whatever fits.
3. Write `workflow.yaml`: one `agent` step per "I would hand-write this prompt and watch it" task. Add `human_approval` steps wherever you'd want to look at output before committing to the next step.
4. `aow run workflow.yaml`. If it fails, `aow show <run-id> --step <id>` will tell you why.

The citation contract feels heavy until you've shipped one workflow with it. Then you stop trusting any AI-written design doc that *doesn't* cite back to its source. It's the same shift as going from "trust me, the tests pass" to "show me the CI badge."
