// Main workflow run loop. Orchestrates loading the YAML, pinning a
// definition snapshot per run, hashing workflow-level inputs, resolving the
// CLI selector, then running steps sequentially. Per docs/workflow-engine.md §4
// steps run one at a time even if the DAG allows parallelism.

import { mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { createAoContext, type AoContext } from "./ao-client.js";
import { DefinitionNotFoundError, WorkflowError } from "./errors.js";
import * as log from "./logger.js";
import { parseWorkflowDefinition } from "./schema.js";
import { resolveSelector } from "./selectors.js";
import { loadRunState, saveRunState } from "./state-store.js";
import type {
  AgentStep,
  ApprovalStep,
  RunID,
  RunState,
  Selector,
  StepID,
  StepStatus,
  WorkflowDefinition,
} from "./types.js";
import { hashAndRecordInputs, openOrCreateRun } from "./engine/run-dir.js";
import { runAgentStep, runApprovalStep } from "./engine/step-runner.js";

const RUNS_DIR = ".workflow-state/runs";
const GATE_POLL_INTERVAL_MS = 5_000;

export interface RunWorkflowOptions {
  workflowPath: string;
  runId?: RunID;
  selector: Selector;
  detach?: boolean;
  /** Test-only hook so integration tests can stub the AO context. */
  aoContextFactory?: (projectId: string) => Promise<AoContext>;
  /** Override the gate-poll cadence in blocking mode (default 5s). */
  gatePollIntervalMs?: number;
  /** Override the completion-detector poll cadence (default 10s). */
  completionPollIntervalMs?: number;
  /** Override the completion-detector idle threshold (default 30s). */
  completionIdleThresholdMs?: number;
  /** Override the completion-detector spawn grace window (default 30s). */
  completionSpawnGraceMs?: number;
}

export interface RunResult {
  runId: RunID;
  runDir: string;
  status: StepStatus;
  steps: Record<StepID, StepStatus>;
  awaitingApprovals: StepID[];
  failed: StepID[];
}

export async function runWorkflow(opts: RunWorkflowOptions): Promise<RunResult> {
  const definitionPath = resolve(opts.workflowPath);
  const yamlText = await readDefinition(definitionPath);
  const workflow = parseWorkflowDefinition(yamlText);

  const projectRoot = dirname(definitionPath);
  const runsRoot = join(projectRoot, RUNS_DIR);

  const { runDir, runId, state, definitionPinned } = await openOrCreateRun({
    runsRoot,
    workflow,
    yamlText,
    requestedRunId: opts.runId,
  });

  if (!definitionPinned) {
    log.info(`resuming run ${runId}`);
  } else {
    log.info(`started run ${runId}`);
  }

  const artifactsDir = isAbsolute(workflow.artifacts_dir)
    ? workflow.artifacts_dir
    : resolve(projectRoot, workflow.artifacts_dir);
  await mkdir(artifactsDir, { recursive: true });

  let runState = await hashAndRecordInputs(runDir, state, workflow, projectRoot);

  const aoCtxFactory = opts.aoContextFactory ?? createAoContext;
  const aoCtx = await aoCtxFactory(workflow.project_id);

  const selection = await resolveSelector(workflow, runState, opts.selector);
  for (const warning of selection.warnings) log.warn(warning);
  log.info(
    selection.toRun.length === 0
      ? "no steps to run (workflow already complete or selector excluded everything)"
      : `steps to run: ${selection.toRun.join(", ")}`,
  );

  runState = await executeLoop({
    aoCtx,
    workflow,
    runDir,
    artifactsDir,
    projectRoot,
    initialState: runState,
    toRun: new Set(selection.toRun),
    detach: opts.detach === true,
    gatePollIntervalMs: opts.gatePollIntervalMs ?? GATE_POLL_INTERVAL_MS,
    completionPollIntervalMs: opts.completionPollIntervalMs,
    completionIdleThresholdMs: opts.completionIdleThresholdMs,
    completionSpawnGraceMs: opts.completionSpawnGraceMs,
  });

  return summarize(runState, runDir, runId);
}

interface ExecuteLoopArgs {
  aoCtx: AoContext;
  workflow: WorkflowDefinition;
  runDir: string;
  artifactsDir: string;
  projectRoot: string;
  initialState: RunState;
  toRun: Set<StepID>;
  detach: boolean;
  gatePollIntervalMs: number;
  completionPollIntervalMs?: number;
  completionIdleThresholdMs?: number;
  completionSpawnGraceMs?: number;
}

async function executeLoop(args: ExecuteLoopArgs): Promise<RunState> {
  let state = args.initialState;
  for (;;) {
    state = await loadRunState(args.runDir);
    const ready = pickReadyStep(state, args.workflow, args.toRun);
    if (!ready) {
      if (anyFailed(state)) {
        await markRunStatus(args.runDir, "failed");
        return await loadRunState(args.runDir);
      }
      if (anyAwaitingApproval(state)) {
        if (args.detach) {
          await markRunStatus(args.runDir, "awaiting_approval");
          return await loadRunState(args.runDir);
        }
        await waitForGateDecision(args.runDir, args.gatePollIntervalMs);
        args.toRun = await expandToRunAfterDecision(args.runDir, args.toRun);
        continue;
      }
      const overall = computeOverallStatus(state);
      await markRunStatus(args.runDir, overall);
      return await loadRunState(args.runDir);
    }

    const step = stepById(args.workflow, ready);
    if (step.type === "agent") {
      const outcome = await runAgentStep(
        {
          aoCtx: args.aoCtx,
          workflow: args.workflow,
          state,
          runDir: args.runDir,
          artifactsDir: args.artifactsDir,
          projectRoot: args.projectRoot,
          completionPollIntervalMs: args.completionPollIntervalMs,
          completionIdleThresholdMs: args.completionIdleThresholdMs,
          completionSpawnGraceMs: args.completionSpawnGraceMs,
        },
        step as AgentStep,
      );
      if (outcome.kind === "failed") {
        log.error(`[${step.id}] ${outcome.reason}`);
        await markRunStatus(args.runDir, "failed");
        return await loadRunState(args.runDir);
      }
      // outcome.kind === "completed" or "revise": loop back and pick next ready
      // step. For "revise" the same step is now `pending` with attempts++ and
      // its feedback file already written for the next spawn.
      continue;
    }

    try {
      const outcome = await runApprovalStep(
        {
          aoCtx: args.aoCtx,
          workflow: args.workflow,
          state,
          runDir: args.runDir,
          artifactsDir: args.artifactsDir,
          projectRoot: args.projectRoot,
        },
        step as ApprovalStep,
      );
      if (outcome.kind === "awaiting_approval") {
        if (args.detach) {
          await markRunStatus(args.runDir, "awaiting_approval");
          return await loadRunState(args.runDir);
        }
        await waitForGateDecision(args.runDir, args.gatePollIntervalMs);
        args.toRun = await expandToRunAfterDecision(args.runDir, args.toRun);
        continue;
      }
    } catch (err) {
      if (err instanceof WorkflowError) {
        log.error(`[${step.id}] ${err.message}`);
        await markRunStatus(args.runDir, "failed");
        return await loadRunState(args.runDir);
      }
      throw err;
    }
  }
}

function pickReadyStep(
  state: RunState,
  workflow: WorkflowDefinition,
  toRun: Set<StepID>,
): StepID | null {
  for (const step of workflow.steps) {
    if (!toRun.has(step.id)) continue;
    const status = state.steps[step.id]?.status ?? "pending";
    if (status !== "pending" && status !== "stale") continue;
    if (!depsSatisfied(step.id, workflow, state)) continue;
    return step.id;
  }
  return null;
}

function depsSatisfied(
  stepId: StepID,
  workflow: WorkflowDefinition,
  state: RunState,
): boolean {
  const step = workflow.steps.find((s) => s.id === stepId);
  if (!step) return false;
  for (const dep of step.depends_on ?? []) {
    const depStatus = state.steps[dep]?.status ?? "pending";
    if (depStatus !== "completed") return false;
  }
  return true;
}

function stepById(
  workflow: WorkflowDefinition,
  id: StepID,
): WorkflowDefinition["steps"][number] {
  const step = workflow.steps.find((s) => s.id === id);
  if (!step) throw new WorkflowError("WF_STEP_NOT_FOUND", `Step not found: ${id}`);
  return step;
}

function anyFailed(state: RunState): boolean {
  return Object.values(state.steps).some((s) => s.status === "failed");
}

function anyAwaitingApproval(state: RunState): boolean {
  return Object.values(state.steps).some((s) => s.status === "awaiting_approval");
}

function computeOverallStatus(state: RunState): StepStatus {
  const statuses = Object.values(state.steps).map((s) => s.status);
  if (statuses.some((s) => s === "failed")) return "failed";
  if (statuses.some((s) => s === "awaiting_approval")) return "awaiting_approval";
  if (statuses.every((s) => s === "completed")) return "completed";
  return "pending";
}

async function markRunStatus(runDir: string, status: StepStatus): Promise<void> {
  const state = await loadRunState(runDir);
  if (state.status === status) return;
  const next: RunState = {
    ...state,
    status,
    updated_at: new Date().toISOString(),
  };
  await saveRunState(runDir, next);
}

async function waitForGateDecision(
  runDir: string,
  intervalMs: number,
): Promise<void> {
  // Block until at least one awaiting_approval step transitions out.
  for (;;) {
    await sleep(intervalMs);
    const state = await loadRunState(runDir);
    if (!anyAwaitingApproval(state)) return;
  }
}

async function expandToRunAfterDecision(
  runDir: string,
  toRun: Set<StepID>,
): Promise<Set<StepID>> {
  const state = await loadRunState(runDir);
  const next = new Set(toRun);
  for (const [id, step] of Object.entries(state.steps)) {
    if (step.status === "pending") next.add(id);
  }
  return next;
}

async function readDefinition(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    throw new DefinitionNotFoundError(path, {
      cause: err instanceof Error ? err : undefined,
    });
  }
}

function summarize(state: RunState, runDir: string, runId: RunID): RunResult {
  const steps: Record<StepID, StepStatus> = {};
  const awaiting: StepID[] = [];
  const failed: StepID[] = [];
  for (const [id, s] of Object.entries(state.steps)) {
    steps[id] = s.status;
    if (s.status === "awaiting_approval") awaiting.push(id);
    if (s.status === "failed") failed.push(id);
  }
  return {
    runId,
    runDir,
    status: state.status,
    steps,
    awaitingApprovals: awaiting,
    failed,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
