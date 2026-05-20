// Resolve CLI selectors (`--only`, `--from`, etc.) to a concrete list of steps
// to execute. See docs/workflow-engine.md §6 for the resolution algorithm.
//
// The module is pure aside from the `only` selector, which must verify that
// declared inputs exist on disk. To keep the rest of the resolver synchronously
// testable we inject a `fileExists` predicate; the default implementation uses
// `fs/promises` so callers in production don't need to think about it.

import { access } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import {
  CycleInSelectorResolutionError,
  MissingInputsError,
  StepNotFoundError,
} from "./errors.js";
import type {
  AgentStep,
  RunState,
  Selector,
  StepID,
  StepStatus,
  WorkflowDefinition,
  WorkflowStep,
} from "./types.js";

export interface SelectorResolution {
  toRun: StepID[];
  warnings: string[];
}

export type FileExistsFn = (absolutePath: string) => Promise<boolean>;

export interface ResolveSelectorOptions {
  fileExists?: FileExistsFn;
}

// `all` includes anything still to be done: never-run steps (pending) and steps
// whose inputs have changed since last completion (stale). Failed/cancelled
// steps require explicit user action (retry, rerun) and aren't picked up here.
const RUNNABLE_STATUSES = new Set<StepStatus>(["pending", "stale"]);

const COMPLETED_STATUSES = new Set<StepStatus>(["completed"]);

const defaultFileExists: FileExistsFn = async (absolutePath) => {
  try {
    await access(absolutePath);
    return true;
  } catch {
    return false;
  }
};

export async function resolveSelector(
  workflow: WorkflowDefinition,
  state: RunState,
  selector: Selector,
  options: ResolveSelectorOptions = {},
): Promise<SelectorResolution> {
  const fileExists = options.fileExists ?? defaultFileExists;
  const graph = buildGraph(workflow);

  switch (selector.kind) {
    case "all":
      return resolveAll(workflow, state, graph);
    case "only":
      return resolveOnly(workflow, selector.stepId, fileExists);
    case "from":
      return resolveFrom(workflow, selector.stepId, graph);
    case "to":
      return resolveTo(workflow, selector.stepId, graph);
    case "through":
      return resolveThrough(workflow, state, selector.stepId, graph);
    case "rerun":
      return resolveRerun(workflow, state, selector.stepId, graph);
  }
}

interface Graph {
  steps: Map<StepID, WorkflowStep>;
  // step -> direct dependencies (upstream)
  deps: Map<StepID, StepID[]>;
  // step -> direct dependents (downstream)
  dependents: Map<StepID, StepID[]>;
  // topological ordering of all steps
  topo: StepID[];
}

function buildGraph(workflow: WorkflowDefinition): Graph {
  const steps = new Map<StepID, WorkflowStep>();
  const deps = new Map<StepID, StepID[]>();
  const dependents = new Map<StepID, StepID[]>();

  for (const step of workflow.steps) {
    steps.set(step.id, step);
    deps.set(step.id, [...(step.depends_on ?? [])]);
    if (!dependents.has(step.id)) dependents.set(step.id, []);
  }
  for (const step of workflow.steps) {
    for (const dep of step.depends_on ?? []) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep)!.push(step.id);
    }
  }

  const topo = topoSort(workflow, deps);
  return { steps, deps, dependents, topo };
}

// Standard Kahn's algorithm. Schema validation rejects cycles, but a defensive
// throw here catches programmatic misuse where a caller built a graph by hand.
function topoSort(
  workflow: WorkflowDefinition,
  deps: Map<StepID, StepID[]>,
): StepID[] {
  const indegree = new Map<StepID, number>();
  const ids: StepID[] = workflow.steps.map((s) => s.id);
  for (const id of ids) indegree.set(id, (deps.get(id) ?? []).length);

  const dependents = new Map<StepID, StepID[]>();
  for (const id of ids) dependents.set(id, []);
  for (const id of ids) {
    for (const dep of deps.get(id) ?? []) {
      dependents.get(dep)!.push(id);
    }
  }

  const order: StepID[] = [];
  // Preserve original declaration order among nodes that are ready at the same
  // time — gives users predictable run sequences.
  const ready: StepID[] = ids.filter((id) => (indegree.get(id) ?? 0) === 0);

  while (ready.length > 0) {
    const next = ready.shift() as StepID;
    order.push(next);
    for (const child of dependents.get(next) ?? []) {
      const remaining = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, remaining);
      if (remaining === 0) ready.push(child);
    }
  }

  if (order.length !== ids.length) {
    const unresolved = ids.filter((id) => (indegree.get(id) ?? 0) > 0);
    throw new CycleInSelectorResolutionError(unresolved);
  }
  return order;
}

function requireStep(workflow: WorkflowDefinition, stepId: StepID): WorkflowStep {
  const step = workflow.steps.find((s) => s.id === stepId);
  if (!step) throw new StepNotFoundError(stepId);
  return step;
}

function statusOf(state: RunState, stepId: StepID): StepStatus {
  return state.steps[stepId]?.status ?? "pending";
}

function resolveAll(
  workflow: WorkflowDefinition,
  state: RunState,
  graph: Graph,
): SelectorResolution {
  const toRun: StepID[] = [];
  for (const id of graph.topo) {
    const status = statusOf(state, id);
    if (RUNNABLE_STATUSES.has(status)) toRun.push(id);
  }
  return { toRun, warnings: [] };
}

async function resolveOnly(
  workflow: WorkflowDefinition,
  stepId: StepID,
  fileExists: FileExistsFn,
): Promise<SelectorResolution> {
  const step = requireStep(workflow, stepId);
  if (step.type !== "agent") {
    return { toRun: [stepId], warnings: [] };
  }
  const inputs = (step as AgentStep).inputs ?? {};
  const missing: string[] = [];
  for (const relPath of Object.values(inputs)) {
    const abs = isAbsolute(relPath)
      ? relPath
      : join(workflow.artifacts_dir, relPath);
    const exists = await fileExists(abs);
    if (!exists) missing.push(abs);
  }
  if (missing.length > 0) throw new MissingInputsError(stepId, missing);
  return { toRun: [stepId], warnings: [] };
}

function resolveFrom(
  workflow: WorkflowDefinition,
  stepId: StepID,
  graph: Graph,
): SelectorResolution {
  requireStep(workflow, stepId);
  const reachable = collectReachable(stepId, graph.dependents);
  reachable.add(stepId);
  return { toRun: filterTopo(reachable, graph.topo), warnings: [] };
}

function resolveTo(
  workflow: WorkflowDefinition,
  stepId: StepID,
  graph: Graph,
): SelectorResolution {
  requireStep(workflow, stepId);
  const reachable = collectReachable(stepId, graph.deps);
  reachable.add(stepId);
  return { toRun: filterTopo(reachable, graph.topo), warnings: [] };
}

function resolveThrough(
  workflow: WorkflowDefinition,
  state: RunState,
  stepId: StepID,
  graph: Graph,
): SelectorResolution {
  requireStep(workflow, stepId);
  const upstream = collectReachable(stepId, graph.deps);
  const needed = new Set<StepID>();
  for (const id of upstream) {
    if (!COMPLETED_STATUSES.has(statusOf(state, id))) needed.add(id);
  }
  needed.add(stepId);
  return { toRun: filterTopo(needed, graph.topo), warnings: [] };
}

function resolveRerun(
  workflow: WorkflowDefinition,
  state: RunState,
  stepId: StepID,
  graph: Graph,
): SelectorResolution {
  requireStep(workflow, stepId);
  const warnings: string[] = [];
  const downstream = collectReachable(stepId, graph.dependents);
  const completedDownstream: StepID[] = [];
  for (const id of downstream) {
    if (COMPLETED_STATUSES.has(statusOf(state, id))) completedDownstream.push(id);
  }
  if (completedDownstream.length > 0) {
    warnings.push(
      `Rerunning "${stepId}" will invalidate completed downstream step(s): ${completedDownstream.join(", ")}. Use --cascade to also re-run them.`,
    );
  }
  return { toRun: [stepId], warnings };
}

function collectReachable(
  start: StepID,
  adjacency: Map<StepID, StepID[]>,
): Set<StepID> {
  const visited = new Set<StepID>();
  const queue: StepID[] = [...(adjacency.get(start) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift() as StepID;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const next of adjacency.get(id) ?? []) {
      if (!visited.has(next)) queue.push(next);
    }
  }
  return visited;
}

function filterTopo(include: Set<StepID>, topo: StepID[]): StepID[] {
  return topo.filter((id) => include.has(id));
}
