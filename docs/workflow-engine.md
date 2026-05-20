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

## 14. Tracked Inputs vs. Prompt-Level References

The `inputs:` map on an agent step is **not** a list of every file the agent
might consult. It is the engine's contract for **what makes this step stale**.

Two kinds of file consumption exist, and they are deliberately distinct:

### Tracked inputs (the `inputs:` map)

```yaml
- id: impl_plan
  depends_on: [lld_review]
  inputs:
    lld: lld.md           # ← change to lld.md invalidates this step
  prompt: |
    Using {{inputs.lld}}, write an implementation plan.
    Reference the HLD at ./workflow-artifacts/hld.md and the design
    doc at ./workflow-artifacts/design.md for context — read only
    the sections you need (e.g., the auth-service section).
```

- Hashed on every run; mismatch → step marked `stale`
- Path interpolated into prompt via `{{inputs.<name>}}`
- Should be the **minimum set** of files whose change should re-run this step

### Prompt-level references

Mentions in the prompt body of files the agent *may* consult but whose changes
should not auto-invalidate the step. The agent reads them on demand, only the
sections it needs.

- Not hashed
- Not interpolated — write the absolute or `artifacts_dir`-relative path
  directly in the prompt text
- The agent is responsible for navigating to and reading the relevant sections

### Why this matters

Without this distinction, the `inputs:` list grows linearly with workflow
depth. By step 8, the implementation-plan step would declare 7 prior outputs
as inputs, each one creating a staleness dependency, every prompt template
ballooning, and every minor edit to an early doc invalidating the entire
downstream chain.

The rule: **declare an input only when its change should re-trigger this
step.** Everything else goes in the prompt as a referenced path the agent
reads on its own initiative.

### Author guidance for prompts with referenced files

When writing a prompt that references files outside `inputs:`, tell the
agent:

1. The exact path (relative to `artifacts_dir` or absolute is fine)
2. Which **sections** are relevant to its task (so it doesn't read the whole
   file blindly when it only needs one chapter)
3. That it should treat referenced files as **read-only context**, not
   sources whose changes it should react to mid-task

Example:

```yaml
prompt: |
  Implement step 3 of the plan in {{inputs.plan}}.

  Background reference (read only the listed sections, do not modify):
  - ./workflow-artifacts/lld.md, section "AuthService class schema"
  - ./workflow-artifacts/hld.md, section "Service boundaries"
```

The engine cares about `plan.md` (declared as input). The agent cares about
`lld.md` and `hld.md` too, but the engine does not track them.

### Tradeoff (honest)

You lose strict reproducibility for referenced files — the agent reads
whatever is on disk at the moment it asks. If `lld.md` changes mid-run, the
agent could in theory see two different versions. For our use case this is
fine: prompt-level references are stable docs that don't change during a
single step's execution. If you need strict tracking, declare it as an
input.

---

## 15. Phase 5+ Roadmap (Deferred)

Phase 1–4 ship a sequential engine with file-based gates and a flat
`artifacts_dir`. This section describes work explicitly NOT in v1, sketched
just enough that today's design doesn't paint us into a corner.

### 15.1 Parallel execution (fan-out / fan-in)

**Current state:** Sequential only. The DAG is respected for dependency
order, but two steps with no edge between them still run one at a time
(§4 — "Phase 1 executes steps sequentially").

**Desired:** When step B and step C both depend only on step A and have no
edge between each other, run B and C concurrently after A completes. A
downstream step D that depends on both B and C waits for both (a join).

**What changes:**
- Run loop becomes a worker pool with a configurable concurrency cap
- State updates must be lock-protected (state-store.ts already has the
  lock primitive; needs broader use)
- Per-step logs need namespacing so parallel agents' output is readable
- Approval gates with multiple upstream parallel steps wait for all of them

**Why deferred:** AO sessions are heavyweight (one tmux + one git worktree
per session). Most workflows are linear chains with occasional fan-out.
Sequential first, parallel later, once the v1 model is proven.

### 15.2 Sub-workflows (a step that is itself a workflow)

**Motivation (from real cases):** The LLD step shouldn't be one prompt — it
should be a writer producing a draft, an architect critiquing it, and a
merger combining the two into the final LLD. Each role is its own agent
session with its own PR, so a reviewer can audit drafts and critiques
separately, not just the final merged doc.

**Desired schema:**

```yaml
- id: lld
  type: workflow
  workflow: ./workflows/lld-with-review.yaml
  inputs:
    hld: hld.md
  outputs:
    lld: lld.md
```

The sub-workflow file (`lld-with-review.yaml`) is a normal workflow file.
Its inputs are bound from the parent step's `inputs:`. Its outputs are
exposed back to the parent via the same name mapping.

**What changes:**
- New `type: workflow` step in schema.ts
- Engine recurses: a workflow step spawns a child run, waits for it, lifts
  the child's terminal outputs back into the parent's artifact namespace
- Run storage: `.workflow-state/runs/<parent>/children/<step-id>/`
- Selectors compose: `aow run feature-dev --only lld.draft` to address a
  step inside a sub-workflow
- Approval gates in the sub-workflow surface up to `aow status` on the
  parent (or stay scoped to the child — TBD)

**Why deferred:** Until you actually need multi-role review *with humans
auditing each role's output separately*, the agent-internal subagent pattern
(prompt says "spawn a critic, merge feedback, produce final") covers it
inside a single step. Sub-workflows become necessary the day you want a
separate PR per role.

### 15.3 Conditional branches

**Motivation:** "If the CI step fails, run a debug step; otherwise skip
straight to PR creation."

**Desired:**

```yaml
- id: maybe_debug
  when: "${ci.status} == 'failed'"
  type: agent
  ...
```

**What changes:**
- A `when:` field on any step with an expression language (start with
  literal equality on prior step states, expand if needed)
- Skipped steps are recorded with `status: skipped` and don't block their
  downstream dependents
- Expression engine: keep small — string equality on artifact paths,
  step status, attempt counts. No Turing-complete sandbox.

**Why deferred:** YAGNI for the design → impl flow. Most current workflows
are unconditional. Add when a real case demands it.

### 15.4 Reviewer agent slot (architect / critic)

**Motivation:** Distinct from sub-workflows — a single agent step where the
engine knows there's a "primary" producer and a "reviewer" that must sign
off before the step is considered complete.

**Desired:**

```yaml
- id: lld
  type: agent
  agent: claude-code
  reviewer:
    agent: gpt-5
    prompt: "Critique {{outputs.lld}} for ..."
    must_approve: true
  prompt: "Write LLD ..."
  outputs:
    lld: lld.md
```

The reviewer runs after the primary. If it approves, step completes. If it
requests changes, primary re-runs with the critique as feedback (like a
rejection cycle but agent-driven instead of human-driven).

**What changes:**
- Schema extension for the `reviewer:` block
- Step runner becomes two-phase: produce → review → loop or commit
- A new error class for reviewer-rejection-exceeds-cap

**Why deferred:** This is a special case of sub-workflows. Better to ship
the general primitive (15.2) than carve out one specific shape.

### 15.5 Dashboard integration

**Motivation:** Watch a workflow run in the AO web dashboard alongside
individual sessions.

**Desired:** AO's web UI shows workflows as first-class entities. Run
state.json is read via the same API surface as session metadata. Steps
appear as a Kanban-style row across the dashboard.

**What changes:**
- New API routes in `packages/web/src/app/api/workflows/` and
  `/runs/[id]/`
- React components for the workflow grid view
- SSE channel for state.json updates

**Why deferred:** v1 is CLI-only by design (§2). The dashboard is
worthwhile but separable; ship the engine first.

### 15.6 Concurrency safety

**Today:** state-store.ts uses a lock file, but only the engine writes
state. Approvals are file-based and atomic via rename.

**Future:** Multiple `aow` invocations on the same run dir (e.g., one in
watch mode, one running `aow status`). Need:
- Read-mostly callers (status, show) bypass the write lock
- Write callers contest the lock with reasonable timeout
- Crashed processes leave stale lock files — needs PID-aware lock recovery

Already mostly there in Phase 1a; just needs to be exercised by real
multi-process use.

### 15.7 Recovery and orphan reconciliation

**Today:** If the engine crashes mid-run, state.json reflects the last
committed transition. The user re-runs `aow resume`. If the agent's AO
session is still alive in tmux but the engine is gone, the user must
manually kill the session.

**Future:** On `aow resume`, the engine queries AO for sessions matching
the recorded session_id and reconciles:
- Session still alive + outputs not yet produced → continue polling
- Session dead + outputs present → mark step completed, hash, move on
- Session dead + outputs missing → mark step failed
- No session found → fresh attempt

AO already has a recovery manager (per `packages/core/src/recovery/`); the
engine just needs to consult it on resume.

### 15.8 Multi-workflow runs in one repo

**Today:** Per §12 decision, one `workflow.yaml` per repo is the assumed
v1 case. The CLI accepts an explicit workflow ID, but examples assume the
default.

**Future:** `workflows/` directory with multiple files, `aow list` shows
them all, `aow run <name>` is fully supported. Already lightly wired in
the CLI from Phase 2; just needs documentation and a real test.

---

## 16. Reference Preservation Across Steps

By step 6 of a workflow, the agent producing `impl-plan.md` is several
hops removed from the original `design.md` it should be implementing. The
risk: each intermediate step paraphrases, the original intent gets
diluted, and by step 8 the implementation contradicts the design doc
written in step 1. **This section defines the convention that prevents
that drift.**

### The Rule

**Every artifact must cite, inline, every upstream file (and section
within that file) it drew material from.** Citations live in the artifact
itself, not in metadata.

When an agent reads a downstream artifact and encounters a citation, it
treats the citation as a navigable pointer: open the cited file, locate
the cited section, verify the current artifact is still consistent with
it.

### Citation Format

Markdown artifacts use HTML comment markers (invisible in rendered
output, parseable by both humans and agents):

```markdown
## AuthService class schema

<!-- ref: hld.md#service-boundaries -->
<!-- ref: design.md#auth-flow -->

The AuthService exposes three methods:
- `login(username, password) → Session`
- ...
```

For non-markdown artifacts (JSON, YAML, code), use the host language's
comment syntax with the same `ref:` prefix:

```typescript
// ref: lld.md#authservice-class-schema
export class AuthService { ... }
```

### Citation Granularity

- **File-level** when the entire file is the source: `<!-- ref: design.md -->`
- **Section-level** when only one section informed this content:
  `<!-- ref: design.md#auth-flow -->` (heading slug, kebab-case, same
  convention as GitHub Markdown anchors)
- **Multiple sources** stacked as separate comments, not merged into one

A single section of output should rarely cite more than 3 sources. If it
does, the step is probably doing too much and should be split.

### Author Responsibilities (Prompt Writers)

When you write the prompt for an agent step, **explicitly instruct the
agent** to:

1. Cite every upstream artifact section it lifts requirements from, using
   the format above
2. Before writing each major section of the output, re-read the cited
   upstream sections to verify alignment
3. If during writing the agent finds a contradiction between the
   downstream task and an upstream source, **stop and surface it** rather
   than silently resolving it

The execution contract footer (§4) should be extended to include this.
Suggested addition for `appendExecutionContract`:

```
=== REFERENCE PRESERVATION ===
When you produce output, cite every upstream file you draw from using:
  <!-- ref: <filename>#<section-slug> -->
inline in the relevant section.

Before writing each major section, re-read the cited sources to verify
your output is consistent with them. If you find a contradiction, stop
and report it in your output rather than silently choosing.
=== END REFERENCE PRESERVATION ===
```

### Reader Responsibilities (Agents Consuming Artifacts)

When an agent reads any artifact and encounters `<!-- ref: X#Y -->`, it
must:

1. **Resolve the path.** The reference is relative to `artifacts_dir`
   unless absolute. The path is the same path the engine uses, so it
   exists on disk if the upstream step completed.
2. **Verify section availability.** Read the cited file, navigate to the
   cited section (heading match by slug).
3. **Read only what's relevant.** Don't read the whole upstream file
   blindly. The section anchor is the contract for relevance.
4. **Verify alignment.** Before acting on the downstream artifact's
   requirement, confirm the upstream section still supports it. If
   upstream has changed in a way that invalidates downstream, flag it.

This is part of agent behavior, not engine behavior. The prompt for each
step should remind the agent of this responsibility.

### Why This Works (and Why It's Not Enforced By Code)

- **Markdown anchors** are stable enough for human-edited docs and
  Claude/Codex handle them reliably
- **Inline citations** travel with the artifact — copy the file
  elsewhere and the lineage moves with it
- **No metadata sidecar** to keep in sync (citations live in the
  artifact, not in state.json)
- **Engine doesn't enforce** because static enforcement is brittle
  (section renames break it, the agent always knows context better than
  a linter could). The convention is in the prompt, in the doc, and in
  the execution contract — that is sufficient

### What Happens When References Break

Three failure modes and the desired response:

| Failure | Detection | Response |
|---|---|---|
| Cited file no longer exists | Reader agent gets file-not-found | Agent flags it in its output: "cannot verify <ref>"; step proceeds but the gap is visible |
| Cited section removed (file renamed sections) | Reader agent finds the file but not the anchor | Same — flag and proceed |
| Cited section semantically changed but anchor stable | Reader agent reads new content and sees mismatch with what it was asked to produce | Agent surfaces the contradiction in its output and (if `human_approval` is downstream) the reviewer catches it |

None of these are silent failures. The point of the convention is to
keep them surfaceable rather than buried.

### Tradeoff with §14

§14 says prompt-level references shouldn't be in `inputs:` because they
shouldn't auto-invalidate the step. §16 says those same files should be
cited inline. **Both stand.** A reference can be:

- Mentioned in the prompt as an *available* upstream file (§14)
- Cited inline in the agent's output to track lineage (§16)
- NOT in the `inputs:` map (no automatic staleness — agent will catch
  drift on next downstream read via §16 verification, not via hash
  comparison)

The two mechanisms cover different failure modes: §14 keeps the
staleness graph minimal; §16 keeps the semantic lineage intact.

### Example (End-to-End)

`design.md` (step 1) defines:

```markdown
## Auth Flow

Users log in with email + password. We never store passwords; we use a
one-way bcrypt hash with cost factor 12.
```

`hld.md` (step 3) implements:

```markdown
## Service Boundaries

<!-- ref: design.md#auth-flow -->

The AuthService owns:
- Password hashing (bcrypt cost 12, per design)
- Session token issuance
```

`lld.md` (step 5) elaborates:

```markdown
## AuthService class schema

<!-- ref: hld.md#service-boundaries -->
<!-- ref: design.md#auth-flow -->

class AuthService {
  hash(password: string): Promise<string>  // bcrypt, cost=12
  verify(password: string, hash: string): Promise<boolean>
  ...
}
```

When the step-7 implementation agent reads `lld.md`, it sees both refs.
It opens `design.md#auth-flow`, confirms the bcrypt-12 requirement, and
implements accordingly. If by step 7 someone has edited `design.md` to
specify bcrypt cost 14, the step-7 agent reads the *new* design.md,
notices the LLD says cost 12 but design says cost 14, and surfaces the
contradiction rather than silently picking one.

---

## Glossary

- **Workflow**: a YAML-defined DAG of steps
- **Run**: a single execution instance of a workflow, identified by run-id
- **Step**: a node in the workflow (agent or approval gate)
- **Attempt**: one execution of a step; rejected steps re-run as new attempts
- **Artifact**: a file produced by a step or supplied as input; identified by path + sha256 hash
- **Tracked input**: a file declared in a step's `inputs:` map; the engine hashes it and uses change as a staleness signal
- **Prompt-level reference**: a file mentioned in a step's prompt body but NOT in `inputs:`; the agent reads it on demand, the engine does not track it
- **Selector**: a CLI flag combination that determines which steps to run (`--only`, `--from`, etc.)
- **Gate**: a human_approval step
- **Stale**: a completed step whose tracked inputs have changed since it last ran
- **Cascade**: re-running downstream steps after an upstream step changes
- **Sub-workflow** (Phase 5+): a step whose execution is itself a workflow; not in v1
- **Reference / citation**: an inline `<!-- ref: <file>#<section> -->` marker in an artifact, pointing to the upstream source that informed that section (see §16)
