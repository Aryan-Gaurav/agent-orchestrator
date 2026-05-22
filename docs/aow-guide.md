# `aow` — Workflow Engine Guide

`aow` runs deterministic, human-gated multi-step workflows on top of Agent Orchestrator (AO). You describe a feature once in YAML and `aow` walks the steps (agent runs, approval gates) end to end, persisting state so partial failures can be resumed.

This guide covers what `aow` does, the commands you'll use, and the YAML you write.

---

## 1. What `aow` is for

AO spawns and supervises **individual** AI coding sessions — one agent, one branch, one PR. `aow` adds the layer above that:

- A workflow is a sequence (or DAG) of **steps**: each is either an agent run or a human approval gate.
- Each step has explicit **inputs** (files) and **outputs** (files), content-addressed by hash. The model is incremental-build (Make/Bazel), not stream-processing (Airflow).
- Selectors let you run one step, a range, or resume from a failure.
- Approvals are file-based — no daemon. You run `aow approve` from a separate terminal to unblock a gate.

If your task is "give one agent one prompt and watch it work", use `ao spawn` directly. If your task is "agent produces design.md → I review it → agent produces hld.md → I review it → agent implements" — that's `aow`.

---

## 2. Setup

`aow` shares its identity layer with AO. The first time you run it in a fresh repo it:

1. **Bootstraps** an `agent-orchestrator.yaml` in the cwd (flat form).
2. **Registers** the project in `~/.agent-orchestrator/config.yaml` so AO core can resolve it.
3. **Auto-starts** the AO daemon (`ao start --no-dashboard`) if it isn't already running.
4. Loads runtime + agent + workspace plugins from the workflow package's own `node_modules`.

You don't have to do any of those manually. The only prerequisite is that `ao` is on your PATH if the daemon needs to be started for you — otherwise `aow` will print a clear instruction.

Run path (no install yet — local development):

```bash
node packages/aow/bin/aow.js <command> [args]
```

When `@aoagents/aow` is published the same commands work as:

```bash
aow <command> [args]
```

---

## 3. Writing a workflow

Workflows are YAML committed to your repo. Minimal example (`workflow.yaml`):

```yaml
id: feature-dev                       # unique workflow id
description: Design → HLD → Impl     # short human-readable summary
artifacts_dir: ./workflow-artifacts   # where step outputs are stored
project_id: my-project                # informational; cwd is the real identity

steps:
  - id: design
    type: agent
    agent: claude-code
    inputs:
      requirements: ./requirements.md
    outputs:
      design: design.md
    prompt: |
      Read requirements.md. Write design.md with sections: Goals, Non-Goals,
      Data Model, Open Questions.

  - id: design_review
    type: human_approval
    depends_on: [design]
    message: |
      Review design.md. Approve to continue, or reject with feedback to
      re-run the design step.

  - id: hld
    type: agent
    agent: claude-code
    depends_on: [design_review]
    inputs:
      design: design.md
    outputs:
      hld: hld.md
    prompt: |
      Read design.md. Write hld.md — module boundaries, public surfaces,
      data flow.
```

### Step types

| Type | What it does |
|------|-------------|
| `agent` | Spawn an AO session running the configured agent. Engine waits until the agent produces all `outputs` files **and** has been idle ≥30s. |
| `human_approval` | Pause the run. Engine writes a pending-gate file. You run `aow approve <run-id> <step-id>` or `aow reject … -m "..."` to continue. |

### Step fields

| Field | Required | Notes |
|-------|----------|-------|
| `id` | yes | Step id, referenced by `depends_on`. |
| `type` | yes | `agent` or `human_approval`. |
| `depends_on` | no | List of step ids this step needs. Default: previous step in the list. |
| `agent` | for `agent` | Plugin name, e.g. `claude-code`, `codex`. |
| `inputs` | no | Map of name → path. Hashed; if any input changes, downstream steps re-run. |
| `outputs` | for `agent` | Map of name → path. All must exist for the step to count as complete. |
| `prompt` | for `agent` | Initial prompt sent to the agent. `{{...}}` placeholders interpolate inputs. |
| `message` | for `human_approval` | Text shown by `aow status` and in the pending-gate file. |
| `max_revisions` | no | Cap on revision loops (rejection → re-run). Default: 3. |

### Citation contract

When a step's prompt references an upstream document (e.g., `inputs.requirements`), `aow` enforces that the agent cites every load-bearing claim back to the source. The format:

- Markdown: `<!-- ref: requirements.md#section-id claim="..." -->`
- Code: `// ref: requirements.md#section-id claim="..."`

`aow` runs a citation linter after each agent step. Missing citations fail the step (the agent re-runs with feedback).

---

## 4. CLI reference

### `aow run <workflow.yaml>`

Run a workflow. Auto-resumes the latest run for this workflow if one exists; otherwise starts a fresh one.

| Flag | Effect |
|------|--------|
| `--only <step>` | Run only that step. |
| `--from <step>` | Run from that step forward. |
| `--to <step>` | Stop after that step. |
| `--through <step>` | Run through and stop after that step (alias). |
| `--input <name>=<path>` | Override a workflow-level input. |
| `--detach` | Don't block on `human_approval` gates — return immediately, gates are awaited by `aow resume`. |

Examples:

```bash
aow run workflow.yaml                       # start or resume the latest run
aow run workflow.yaml --only hld            # re-run only the hld step
aow run workflow.yaml --from impl           # run impl onward
```

### `aow status [<run-id>]`

Show the state of a run (defaults to the latest). Lists steps, statuses, current pending gates.

### `aow approve <run-id> <step-id>`

Approve a pending `human_approval` gate. The blocked run continues.

### `aow reject <run-id> <step-id> -m "<feedback>"`

Reject a gate. Feedback is injected into the prompt of the upstream agent step on its next attempt.

### `aow show <run-id> [--step <id>] [--json] [--hops]`

Show the full state of a run or one step. `--hops` traces citation references back through the document chain (e.g. an `impl` claim that cites `hld.md#modules` which itself cites `design.md#data-model` which cites `requirements.md#functional-requirements`).

### `aow resume <run-id>`

Continue a `--detach` run after gates have been approved. Useful in scripts.

### `aow list`

List workflows visible in the cwd.

### `aow runs`

List active + recent runs in the cwd.

---

## 5. Run state

State lives in `.workflow-state/runs/<run-id>/` next to your workflow.yaml:

```
.workflow-state/runs/wf-feature-dev-20260522T001245/
  definition.yaml         # pinned snapshot of workflow.yaml at run start
  state.json              # per-step status, hashes, attempt counts
  pending/                # one file per active human_approval gate
  feedback/               # rejection feedback messages
  artifacts/              # copies of step outputs, hashed
```

`.workflow-state/` is safe to gitignore. Re-running a step with the same inputs is a no-op (cache hit by hash). Editing a step's inputs invalidates downstream steps' hashes — they re-run.

---

## 6. How `aow` talks to AO

For every agent step, `aow` does:

1. Resolve the project (cwd-path → entry in `~/.agent-orchestrator/config.yaml`).
2. Render the prompt (template + execution contract + any rejection feedback).
3. Call AO's `SessionManager.spawn` with that project + agent + branch + prompt.
4. Poll `LifecycleManager` until the session produces the declared outputs **and** has been idle ≥30s (the completion contract).
5. Verify outputs exist, hash them, store under `artifacts/`, record in `state.json`.
6. Move to the next step.

`aow` never writes to AO's global config directly — registration is delegated to AO's exported `registerProjectInGlobalConfig`. The cwd is the source of truth for project identity; `project_id` in your workflow.yaml is a label.

---

## 7. Common patterns

### Single-agent feature flow

`design → review → hld → review → impl → review` with a different reviewer at each gate. Simplest case.

### Self-revising loop

`agent → linter (auto-rejects on failure) → agent re-runs with linter feedback → manual review`. The citation linter is a built-in example.

### Forked alternatives

Run `--only design` twice into two artifact dirs, then approve only one. (DAG fan-out is on the roadmap; today you do this manually.)

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `AO is not running` | Daemon died or wasn't started. | `aow run` auto-starts it; if `ao` isn't on PATH, install it: `npm i -g @aoagents/ao`. |
| `Runtime plugin 'tmux' not found` | Plugin resolution found the wrong tree. | Re-run `pnpm install` at the monorepo root. If you're outside the monorepo, the published `aow` package bundles its deps. |
| `Project 'foo' not found in AO config` | Workflow's `project_id` doesn't match any registered project. | The cwd-fallback should handle this. If you see it, check `cat ~/.agent-orchestrator/config.yaml` and ensure your cwd's `path:` is registered. |
| `Unable to resolve base ref for default branch "main"` | The cwd is a git repo with no commits. | `git commit --allow-empty -m init` or make a real commit. |
| Step never completes | Agent is at a permission prompt or blocked. | `tmux attach -t <session-id>` and check. |

---

## 9. What's not in v1

- Parallel fan-out / fan-in (sequential only today).
- Conditional branches (if/else).
- Sub-workflows (a step that itself runs a workflow).
- Dashboard UI (CLI only).

These are designed-for in `docs/workflow-engine.md` but deferred.
