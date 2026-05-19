# Workflow Engine — Design & Implementation Guide

**Status:** Design proposal, v1
**Audience:** Engineers (human or AI agent) implementing this package
**Scope:** New extension package `packages/workflow/` that sits on top of `@aoagents/ao-core` without modifying it

---

## 1. Motivation

Agent Orchestrator (AO) spawns and supervises individual AI coding sessions. Each session is independent — there's no concept of multi-step workflows, document handoffs between agents, or human approval gates between stages.

This package adds a **deterministic, human-gated workflow layer** on top of AO. The user describes a feature once, then a defined sequence of agent-and-human steps produces design docs, HLD, LLD, an implementation plan, incremental code changes, and a reviewed PR — with the human in the loop at each stage.

Inspiration is **incremental build systems (Make/Bazel)**, not workflow runners like Airflow. Every node has explicit file inputs and outputs, content-addressed by hash. Partial execution, staleness detection, and resumption all fall out of the artifact model.

### Goals

- A new package `packages/workflow/` that depends only on `@aoagents/ao-core` (no core modifications)
- Ships its own CLI binary `aow` (because AO's CLI commands are hardcoded; we can't add an `ao workflow` subcommand without forking the CLI)
- Workflows defined in YAML files committed to a user's repo
- Agent steps and human approval gates compose into a DAG
- Partial execution: run a single node, a path, or resume from a failure
- Deterministic: hashed inputs/outputs make staleness detection and re-runs predictable

### Non-Goals (Phase 1)

- Parallel fan-out / fan-in
- Conditional branches
- Reviewer agent slots (separate "architect review" agents)
- Sub-workflows (a node defined as another workflow)
- Dashboard UI (CLI only in v1)

These are designed-for in this doc but **deferred to later phases.**

---

## 2. Architecture Overview

```
┌────────────────────────────────────────┐
│           aow CLI (binary)             │
│   run · status · approve · reject ·    │
│   retry · resume · cancel · show       │
└────────────────────┬───────────────────┘
                     │
┌────────────────────▼───────────────────┐
│         Workflow Engine                │
│  schema  state-store  artifact-store   │
│  selectors  approvals  ao-client       │
└────────────────────┬───────────────────┘
                     │
┌────────────────────▼───────────────────┐
│        @aoagents/ao-core               │
│  SessionManager · LifecycleManager     │
│  spawn · send · kill · restore · list  │
└────────────────────────────────────────┘
                     │
                  Agent Sessions
              (Claude Code, Codex, ...)
```

The engine reads `workflow.yaml` from the user's repo, runs a DAG of steps, and orchestrates AO sessions for agent steps. Approval gates pause execution until the user runs `aow approve`.

---

## 3. Workflow Definition Schema

A workflow is YAML committed to the user's repo. Example for a feature-development flow:

```yaml
id: feature-dev
description: "Design → HLD → LLD → Impl plan → Incremental impl"
artifacts_dir: ./workflow-artifacts        # where docs/outputs live
project_id: my-project                     # AO project ID (matches agent-orchestrator.yaml)

inputs:
  - name: feature_description
    path: ./feature.md                     # external input file

steps:
  - id: design_doc
    type: agent
    agent: claude-code                     # which AO agent plugin to use
    prompt: |
      Read the feature description at {{inputs.feature_description}}.
      Write a design doc covering:
      - existing pages/flows affected
      - proposed UX changes
      - scope boundaries (in / out)
      Save to {{outputs.design}}.
      When done, ensure {{outputs.design}} exists, then stop.
    outputs:
      design: design.md
    timeout_minutes: 30

  - id: design_review
    type: human_approval
    depends_on: [design_doc]
    message: |
      Review workflow-artifacts/design.md.
      Approve to proceed, or reject with feedback to regenerate.
    on_reject: design_doc
    max_revisions: 5

  - id: hld
    type: agent
    agent: claude-code
    depends_on: [design_review]
    inputs:
      design: design.md                    # input from previous step's output
    prompt: |
      Using {{inputs.design}}, write an HLD covering:
      - backend services and their responsibilities
      - data flow between services
      - database schema (tables, relationships)
      - external API contracts
      Save to {{outputs.hld}}.
    outputs:
      hld: hld.md
    timeout_minutes: 45

  - id: hld_review
    type: human_approval
    depends_on: [hld]
    message: "Review workflow-artifacts/hld.md"
    on_reject: hld
    max_revisions: 5

  - id: lld
    type: agent
    agent: claude-code
    depends_on: [hld_review]
    inputs:
      hld: hld.md
    prompt: |
      Using {{inputs.hld}}, write LLD covering:
      - class/interface schemas with method signatures
      - interaction diagrams between modules
      - data transformations
      Save to {{outputs.lld}}.
    outputs:
      lld: lld.md
    timeout_minutes: 45

  - id: lld_review
    type: human_approval
    depends_on: [lld]
    message: "Review workflow-artifacts/lld.md"
    on_reject: lld

  - id: impl_plan
    type: agent
    agent: claude-code
    depends_on: [lld_review]
    inputs:
      design: design.md
      hld: hld.md
      lld: lld.md
    prompt: |
      Reference {{inputs.design}}, {{inputs.hld}}, {{inputs.lld}}.
      Write a sequenced implementation plan as a numbered list.
      Each step must:
      - cite which doc section it implements
      - list files to create / modify
      - specify the tests to write
      Save to {{outputs.plan}}.
    outputs:
      plan: impl-plan.md

  - id: plan_review
    type: human_approval
    depends_on: [impl_plan]
    message: "Review workflow-artifacts/impl-plan.md"
    on_reject: impl_plan
```

### Schema Field Reference

**Top-level**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Workflow ID; used in run-IDs and CLI |
| `description` | string | no | Human-readable description |
| `artifacts_dir` | string | yes | Relative path where artifacts (docs) are stored |
| `project_id` | string | yes | AO project ID (must match a configured AO project) |
| `inputs` | array | no | External input files (paths supplied by user, not produced by steps) |
| `steps` | array | yes | List of step definitions |

**Step common fields**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Step ID; unique within workflow; used in selectors |
| `type` | enum | yes | `agent` \| `human_approval` (Phase 1) |
| `depends_on` | string[] | no | Step IDs that must complete before this can run |

**Step type: `agent`**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent` | string | yes | AO agent plugin name (e.g., `claude-code`, `codex`) |
| `prompt` | string | yes | Prompt template (Mustache-style `{{...}}` interpolation) |
| `inputs` | map<name, path> | no | Named input files from artifacts_dir |
| `outputs` | map<name, path> | yes | Named output files the agent must produce |
| `timeout_minutes` | number | no | Max time before failing (default: 60) |
| `branch` | string | no | Override branch name (default: `aow-<workflow-id>-<step-id>-<attempt>`) |

**Step type: `human_approval`**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | yes | Shown to user when gate is awaiting |
| `on_reject` | string | yes | Step ID to loop back to on rejection |
| `max_revisions` | number | no | Cap on rejection cycles (default: 5) |

### Template Interpolation

Inside `prompt`, `{{inputs.<name>}}` expands to the absolute path of the input file. `{{outputs.<name>}}` expands to the absolute path where the agent should write the output.

Workflow-level `inputs` are also accessible via `{{inputs.<name>}}` from any step. Naming collision with step-local `inputs` is an error at validation time.

---

## 4. Execution Semantics

### State Machine per Step

```
        ┌──── pending ──── (deps complete) ────┐
        │                                       │
        │                                       ▼
        │                                    running
        │                                       │
        │              ┌── (agent stops) ───────┤
        │              │                        │
        │              ▼                        ▼
        │           awaiting_approval     completed
        │              │     │                  │
        │   (reject)   │     │ (approve)        │
        │              ▼     ▼                  │
        └─────── pending     completed ─────────┤
                                                │
                                            (failed)
                                                │
                                                ▼
                                              failed
```

Step statuses: `pending`, `running`, `awaiting_approval`, `completed`, `failed`, `cancelled`, `stale`.

**`stale`** is a derived status: a `completed` step whose inputs have changed hashes since it last ran. Stale steps don't auto-re-run; the user is prompted on the next `aow run`.

### Run Loop

```
1. Load workflow.yaml; validate via Zod schema; check for cycles
2. Load or create state.json for this run
3. Loop:
   a. Find ready steps: status == pending AND all deps completed
   b. For each ready step:
      - if type == agent: spawn AO session, poll until done, verify outputs
      - if type == human_approval: write pending/<step>.json, mark awaiting
   c. If no ready steps and any awaiting_approval: pause and exit
   d. If all steps completed: succeed
   e. If any step failed and no retry: surface error and exit
```

For Phase 1, **steps execute sequentially**, even if their `depends_on` graph allows parallelism. (Parallel execution lands in Phase 3.)

### Spawning an Agent Step

```typescript
// pseudocode
const branch = step.branch ?? `aow-${workflow.id}-${step.id}-${attempt}`;
const session = await sm.spawn({
  projectId: workflow.project_id,
  agent: step.agent,
  branch,
  prompt: renderPromptTemplate(step.prompt, { inputs, outputs }),
});

await persistSessionRef(runId, step.id, attempt, session.id);
await pollUntilStepDone(session.id, step, timeoutMs);
await verifyOutputs(step.outputs);
await hashAndRecord(step.outputs);
```

### Completion Detection Contract (Critical)

AO has no first-class "this prompt is finished" signal. We use a **two-check contract**:

1. **All declared output files exist** at their declared paths inside `artifacts_dir`
2. **Activity state is `idle`** (per `session.activity`) for ≥30 seconds

Both must hold. The poll interval is 10s.

Prompts include an auto-appended footer:

```
=== AOW EXECUTION CONTRACT ===
When you are done with this task:
1. Ensure these files exist at the exact paths shown:
   - {{outputs.<name>}}: <absolute path>
   - ...
2. Do NOT commit or push.
3. Stop working — do not start additional tasks.
```

If outputs don't exist after `timeout_minutes`, the step is marked `failed` with reason `output_missing`.

### Approval Gates

When a `human_approval` step is reached:

1. Engine writes `pending/<step-id>.json` to the run dir:
   ```json
   {
     "step_id": "design_review",
     "message": "Review workflow-artifacts/design.md",
     "awaiting_since": "2026-05-20T12:00:00Z",
     "artifacts_to_review": ["workflow-artifacts/design.md"]
   }
   ```
2. Engine marks step `awaiting_approval` and **exits** (run mode) or **blocks** (watch mode).
3. User runs `aow approve <run-id> <step-id>` → engine writes decision, deletes pending file, resumes.
4. Or `aow reject <run-id> <step-id> -m "feedback text"` → engine resets the `on_reject` target step to `pending`, attaches feedback to its next attempt.

When a rejected step re-runs, its prompt is wrapped with prior-attempt feedback:

```
=== PRIOR ATTEMPT FEEDBACK ===
Previous attempt was rejected. Reviewer said:
> <feedback text>

Please revise and address this feedback. Read the prior output at
<artifacts_dir>/<output> as the starting point, do NOT throw it away.
=== END FEEDBACK ===

<original prompt>
```

### Revision Loop Cap

Each step tracks an `attempt` counter. When attempt would exceed `max_revisions`, the step is marked `failed` with reason `revision_limit_exceeded`. The user can `aow retry --reset-attempts <run> <step>` to force another try.

---

## 5. State Management

### Run Directory Layout

```
<repo-root>/
  workflow.yaml                              # user-authored
  feature.md                                 # user-supplied input
  workflow-artifacts/                        # produced docs (gitignorable)
    design.md
    hld.md
    lld.md
    impl-plan.md
  .workflow-state/                           # engine bookkeeping
    runs/
      wf-feature-dev-20260520-120000/
        definition.yaml                      # pinned snapshot of workflow.yaml
        state.json                           # the source of truth
        pending/
          design_review.json                 # exists while awaiting
        sessions/
          design_doc-attempt-1.json          # AO session reference
          design_doc-attempt-2.json
        feedback/
          design_doc-attempt-1.md            # feedback that triggered attempt 2
```

### state.json Schema

```json
{
  "run_id": "wf-feature-dev-20260520-120000",
  "workflow_id": "feature-dev",
  "started_at": "2026-05-20T12:00:00Z",
  "updated_at": "2026-05-20T12:35:00Z",
  "status": "awaiting_approval",
  "inputs": [
    {
      "name": "feature_description",
      "path": "./feature.md",
      "hash": "sha256:abc123..."
    }
  ],
  "steps": {
    "design_doc": {
      "status": "completed",
      "attempts": 1,
      "current_attempt": {
        "session_id": "ses-xyz",
        "branch": "aow-feature-dev-design_doc-1",
        "started_at": "2026-05-20T12:00:00Z",
        "completed_at": "2026-05-20T12:15:00Z",
        "inputs": [
          {"name": "feature_description", "path": "./feature.md", "hash": "sha256:abc123..."}
        ],
        "outputs": [
          {"name": "design", "path": "workflow-artifacts/design.md", "hash": "sha256:def456..."}
        ]
      },
      "history": []
    },
    "design_review": {
      "status": "awaiting_approval",
      "awaiting_since": "2026-05-20T12:15:00Z"
    },
    "hld": { "status": "pending" }
  }
}
```

### Staleness Detection

When `aow run` starts:

1. For each `completed` step, re-hash its recorded inputs.
2. If any input hash mismatches the recorded hash → mark step `stale`.
3. Surface stale steps to user; prompt: "These steps have stale inputs: [list]. Re-run? [y/N/select]"

Staleness propagates: a stale step's outputs are not trustworthy, so its downstream `completed` steps with that output as input also become stale.

**Auto-rerun is opt-in** via `--cascade` flag. Default behavior is to prompt.

### Concurrent External Edits

If a user manually edits `workflow-artifacts/design.md` between runs:
- Recorded output hash no longer matches file hash.
- On next run, engine prompts: "design.md has been edited externally. Use the current version (hash will be updated) or revert (re-run design_doc step)?"

---

## 6. Selectors — Partial Execution

```bash
aow run feature-dev                          # full workflow (or resume)
aow run feature-dev --only hld               # just hld; fail if inputs missing
aow run feature-dev --from hld               # hld onwards
aow run feature-dev --to hld                 # everything up to and including hld
aow run feature-dev --through lld            # lld + its transitive deps (whatever's needed)
aow run feature-dev --rerun hld              # invalidate hld; interactive cascade prompt
aow run feature-dev --skip design_review --force  # skip an approval gate (requires --force)
aow run feature-dev --input design=./external-design.md  # inject external artifact
```

### Resolution Algorithm

```typescript
function resolveStepsToRun(workflow, state, selector): StepID[] {
  switch (selector.kind) {
    case "all":
      // Return all pending + stale + ready steps in topological order
    case "only":
      // Return [selector.stepId] iff its inputs are present (on disk)
      // Else throw with hint: "use --through or --input"
    case "from":
      // Return all steps reachable from selector.stepId in topological order
    case "to":
      // Return all steps that selector.stepId transitively depends on, including itself
    case "through":
      // Return transitive deps of selector.stepId that are NOT already completed,
      // followed by selector.stepId itself
    case "rerun":
      // Mark selector.stepId as pending (forces re-run), then run from there
      // Interactive prompt for cascade if downstream is completed
  }
}
```

### `--input` Override

`--input <name>=<path>` copies an external file into the workflow-artifacts dir under the given name, hashes it, and treats it as if it were produced by an upstream step. This is how you "skip" the design step but still run HLD by injecting your own design doc.

---

## 7. CLI Surface

```bash
# Discovery
aow list                                     # workflows in cwd (./workflow.yaml + ./workflows/*.yaml)
aow runs                                     # active + recent runs
aow show <run-id>                            # run details
aow show <run-id> --step <id>                # step details (attempts, feedback, session ref)

# Execution
aow run <workflow> [--only|--from|--to|--through <step>] [--input ...] [--detach]
aow resume <run-id>                          # continue paused run
aow retry <run-id> <step-id>                 # retry a failed step (new attempt)
aow rerun <run-id> <step-id>                 # invalidate completed step; cascade prompt
aow cancel <run-id>                          # cancel + kill any active sessions

# Gates
aow approve <run-id> <step-id>
aow reject <run-id> <step-id> -m "feedback text"

# Maintenance
aow status <run-id>                          # short status summary
aow gc                                       # garbage-collect old runs (with confirmation)
```

### Flags

| Flag | Purpose |
|------|---------|
| `--detach` | After spawning current step, exit instead of blocking |
| `--cascade` | Auto-rerun downstream stale steps without prompting |
| `--force` | Bypass safety prompts (skip gates, override stale, etc.) |
| `--json` | Machine-readable output |
| `--workflow-file <path>` | Override workflow.yaml location (default: ./workflow.yaml) |

---

## 8. Package Layout

```
packages/workflow/
  package.json                               # name: @aoagents/ao-workflow
                                             # bin: { aow: "./dist/cli.js" }
                                             # deps: @aoagents/ao-core (workspace:*),
                                             #       commander, zod, yaml, chalk
  tsconfig.json                              # extends ../../tsconfig.base.json
  README.md
  src/
    cli.ts                                   # commander entrypoint
    index.ts                                 # programmatic exports
    types.ts                                 # all internal types
    schema.ts                                # Zod schema for workflow.yaml + runtime validation
    engine.ts                                # main run loop
    state-store.ts                           # state.json read/write, atomic updates
    artifact-store.ts                        # file copy + sha256, artifact resolution
    selectors.ts                             # --only/--from/etc resolution
    ao-client.ts                             # thin wrapper over @aoagents/ao-core
    approvals.ts                             # gate file handshake
    completion-detector.ts                   # poll for step done
    prompt-template.ts                       # mustache-style interpolation + execution-contract footer
    logger.ts                                # consistent stdout/stderr formatting
    errors.ts                                # custom error types with codes
    __tests__/
      schema.test.ts
      state-store.test.ts
      artifact-store.test.ts
      selectors.test.ts
      engine.integration.test.ts             # 2-node hello-world workflow
  examples/
    hello-world/
      workflow.yaml                          # 2-step: agent → human_approval
      input.md
    feature-dev/
      workflow.yaml                          # the full design → impl flow shown above
```

---

## 9. Module Responsibilities

### `types.ts`
Core type definitions. No runtime logic. Exports:
- `WorkflowDefinition`, `WorkflowStep`, `AgentStep`, `ApprovalStep`
- `RunState`, `StepState`, `StepStatus`, `AttemptRecord`
- `Artifact`, `ArtifactRef`
- `Selector`, `SelectorKind`

### `schema.ts`
Zod schemas mirroring `types.ts`. One exported function:
```typescript
export function parseWorkflowDefinition(yamlText: string): WorkflowDefinition
```
Throws `WorkflowValidationError` with field paths on invalid input. Additional checks beyond Zod:
- All `depends_on` IDs exist
- No cycles (DFS-based detection)
- All `on_reject` IDs exist and are reachable upstream
- All template variables in prompts reference valid inputs/outputs

### `state-store.ts`
Read/write `state.json` atomically (write-to-temp + rename). Functions:
- `loadRunState(runDir): RunState`
- `saveRunState(runDir, state): Promise<void>` — atomic
- `updateStep(runDir, stepId, updater): Promise<void>` — read-modify-write with lock file

### `artifact-store.ts`
File hashing and artifact management. Functions:
- `hashFile(absPath): Promise<string>` — sha256 hex
- `resolveArtifactPath(artifactsDir, relPath): string`
- `copyArtifact(src, dest): Promise<{path, hash}>`
- `verifyArtifact(absPath, expectedHash): Promise<boolean>`

### `selectors.ts`
Resolve CLI selectors to a list of steps to execute.
```typescript
export function resolveSelector(
  workflow: WorkflowDefinition,
  state: RunState,
  selector: Selector,
): { toRun: StepID[], warnings: string[] }
```

### `ao-client.ts`
Thin facade over `@aoagents/ao-core`. The engine never imports `ao-core` directly — only through this module. Functions:
- `spawnAgentSession(opts): Promise<{sessionId, branch}>`
- `getSessionStatus(sessionId): Promise<{status, activity, lastActivityAt}>`
- `killSession(sessionId, reason): Promise<void>`
- `createAoContext(projectId): Promise<{sm, lm, config}>` — initializes registry + managers from the user's AO config

### `completion-detector.ts`
Poll loop for an agent step:
```typescript
export async function waitForStepCompletion(
  sessionId: SessionId,
  expectedOutputs: ArtifactRef[],
  opts: { timeoutMs: number, idleThresholdMs?: number, pollIntervalMs?: number },
): Promise<CompletionResult>
```
Two-check contract (outputs exist + activity idle ≥30s). Returns success, timeout, or session-failure.

### `approvals.ts`
File-based gate handshake:
- `enterGate(runDir, stepId, message): Promise<void>` — writes pending file, updates state
- `decideGate(runDir, stepId, decision: "approve"|"reject", feedback?): Promise<void>`
- `awaitDecision(runDir, stepId, opts: { mode: "blocking"|"poll" }): Promise<Decision>`

### `prompt-template.ts`
Render `{{...}}` placeholders. Append execution contract. Inject prior-attempt feedback.

### `engine.ts`
The orchestrator. Single exported function:
```typescript
export async function runWorkflow(opts: {
  workflowPath: string;
  runId?: string;            // optional: resume specific run; default: create new or auto-resume latest
  selector: Selector;
  detach?: boolean;
}): Promise<RunResult>
```

Implements the run loop in §4. Delegates to the modules above.

### `cli.ts`
`commander` setup. Each command is a thin wrapper:
- Parses args → builds a Selector
- Calls `runWorkflow`, `decideGate`, `loadRunState`, etc.
- Formats output via `logger.ts`

---

## 10. Phased Implementation Plan

The package will be built across multiple AO sessions, each opening a PR against `feature/workflow-engine`. Phases are sequential; sessions within a phase can be parallel (when files are disjoint).

### Phase 0 — Foundation (1 session)
**Files:** `package.json`, `tsconfig.json`, `src/types.ts`, `src/schema.ts`, `src/errors.ts`, `src/__tests__/schema.test.ts`

**Acceptance:**
- Package builds (`pnpm --filter @aoagents/ao-workflow build`)
- `parseWorkflowDefinition` round-trips the examples/feature-dev/workflow.yaml
- Schema rejects cycles and bad on_reject refs with clear errors
- 10+ schema tests pass

### Phase 1 — Independent foundations (3 parallel sessions)

**1a: artifact-store + state-store**
**Files:** `artifact-store.ts`, `state-store.ts`, tests
**Acceptance:** Atomic state writes, sha256 stability, lock file semantics

**1b: selectors + prompt-template**
**Files:** `selectors.ts`, `prompt-template.ts`, tests
**Acceptance:** All 5 selector kinds resolve correctly; template renders + appends contract

**1c: ao-client + completion-detector**
**Files:** `ao-client.ts`, `completion-detector.ts`, tests
**Acceptance:** Mocked AO session reaches completion when outputs appear + activity idle

### Phase 2 — Engine + CLI integration (1 session)
**Files:** `engine.ts`, `approvals.ts`, `cli.ts`, `logger.ts`, end-to-end test
**Acceptance:**
- E2E test: run examples/hello-world (1 agent step + 1 approval gate) against a mock AO client
- All `aow` commands functional
- Resume after crash works (kill mid-run, re-run, state recovered)

### Phase 3 — Real AO integration (1 session)
**Files:** Wire to real `@aoagents/ao-core` instead of mocks; integration test against a real AO project
**Acceptance:** examples/hello-world runs end-to-end with a real `ao spawn`

### Phase 4 — Examples + docs (1 session)
**Files:** examples/*, README.md, `aow --help` polish
**Acceptance:** Fresh user can clone, follow README, run a workflow

---

## 11. Testing Strategy

- **Unit tests:** every module has a `__tests__/` peer file. Vitest.
- **Integration tests:** `engine.integration.test.ts` runs a small workflow end-to-end against a mocked `ao-client`. Validates state transitions, file artifacts, approval gates.
- **Smoke tests:** in CI, run `aow run examples/hello-world` against a stub AO client. Ensures CLI plumbing works.
- **Manual tests:** Phase 3+ — run against real AO project.

### Mock AO Client

For unit/integration tests, provide a `MockAoClient` that:
- Returns a fake session ID on spawn
- Simulates a configurable delay before writing the expected output files
- Reports activity transitions on a timeline
- Supports failure injection (timeout, exit, missing outputs)

---

## 12. Open Questions / Decisions for v1

These are settled for v1 but flagged here for future revisit:

1. **Sequential execution only.** Even when DAG allows parallelism. Reason: simpler state model, easier debugging. Parallel arrives in Phase 5.

2. **No sub-workflows.** A node cannot be defined as another workflow. Design accommodates this addition but it's deferred.

3. **File-based approval gates.** Not a web UI. CLI only. The dashboard integration is deferred.

4. **One workflow.yaml per repo.** Multi-workflow support exists (CLI accepts workflow ID) but for v1 examples we assume `./workflow.yaml`.

5. **No agent recovery beyond AO's native restore.** If a session dies, the engine marks the step failed; user must `aow retry`. AO's own recovery may have already restored the session under the hood — engine respects current session status when polling.

6. **Workflow YAML is pinned per run.** Editing workflow.yaml mid-run doesn't affect the current run. New runs use the new YAML.

7. **No cross-run artifact references.** Designed for, deferred.

---

## 13. How to Run Phase 0 (For the First AO Session)

This document IS the spec. The first AO session is given:

1. This file (`docs/workflow-engine.md`) — as the source of truth
2. Phase 0 acceptance criteria (above)
3. A list of files to create

The session works in a worktree off `feature/workflow-engine` and opens a PR back into it. After PR merge, Phase 1 sessions kick off in parallel.

### Phase 0 Session Prompt (Template)

```
You are building the foundation of the workflow engine package as described in
docs/workflow-engine.md. Read that file completely before starting.

Your task is Phase 0: foundation only.

Create these files inside a new package at packages/workflow/:
- package.json (name: @aoagents/ao-workflow, bin: aow → dist/cli.js, deps:
  @aoagents/ao-core (workspace:*), commander, zod, yaml, chalk)
- tsconfig.json (extends ../../tsconfig.base.json)
- src/types.ts — all type definitions per §9
- src/schema.ts — Zod schema + parseWorkflowDefinition() per §9
- src/errors.ts — error classes (WorkflowValidationError, etc.)
- src/__tests__/schema.test.ts — at least 10 tests covering happy path,
  cycle detection, bad on_reject refs, missing template vars

Constraints:
- Do not modify any existing AO core or plugin code.
- Follow CLAUDE.md conventions: no `any`, no inline styles, strict TS.
- Match existing package structure in packages/cli/ for layout reference.
- Add the new package to pnpm-workspace.yaml if needed.

Acceptance:
- `pnpm install && pnpm --filter @aoagents/ao-workflow build` succeeds
- `pnpm --filter @aoagents/ao-workflow test` passes
- `pnpm typecheck` still passes for the whole monorepo

When done, open a PR titled "feat(workflow): phase 0 — package foundation"
targeting feature/workflow-engine.
```

---

## Glossary

- **Workflow**: a YAML-defined DAG of steps
- **Run**: a single execution instance of a workflow, identified by run-id
- **Step**: a node in the workflow (agent or approval gate)
- **Attempt**: one execution of a step; rejected steps re-run as new attempts
- **Artifact**: a file produced by a step or supplied as input; identified by path + sha256 hash
- **Selector**: a CLI flag combination that determines which steps to run (`--only`, `--from`, etc.)
- **Gate**: a human_approval step
- **Stale**: a completed step whose inputs have changed since it last ran
- **Cascade**: re-running downstream steps after an upstream step changes
