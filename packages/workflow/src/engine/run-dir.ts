// Run-directory bookkeeping: create or resume a run, pin the workflow
// definition snapshot, and hash workflow-level inputs into the RunState.
// Pulled out of engine.ts to keep that file focused on the run loop.

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { hashFile } from "../artifact-store.js";
import { RunNotFoundError } from "../errors.js";
import {
  createRunState,
  loadRunState,
  saveRunState,
} from "../state-store.js";
import type {
  Artifact,
  RunID,
  RunState,
  WorkflowDefinition,
} from "../types.js";

const DEFINITION_SNAPSHOT_FILENAME = "definition.yaml";

export interface OpenRunArgs {
  runsRoot: string;
  workflow: WorkflowDefinition;
  yamlText: string;
  requestedRunId?: RunID;
}

export interface OpenRunResult {
  runDir: string;
  runId: RunID;
  state: RunState;
  /** True if we wrote the definition snapshot in this call. */
  definitionPinned: boolean;
}

export async function openOrCreateRun(args: OpenRunArgs): Promise<OpenRunResult> {
  await mkdir(args.runsRoot, { recursive: true });

  if (args.requestedRunId) {
    const runDir = join(args.runsRoot, args.requestedRunId);
    try {
      const state = await loadRunState(runDir);
      return { runDir, runId: args.requestedRunId, state, definitionPinned: false };
    } catch (err) {
      throw new RunNotFoundError(args.requestedRunId, {
        cause: err instanceof Error ? err : undefined,
      });
    }
  }

  const existing = await findResumableRun(args.runsRoot, args.workflow.id);
  if (existing) {
    return {
      runDir: existing.runDir,
      runId: existing.runId,
      state: existing.state,
      definitionPinned: false,
    };
  }

  const now = new Date().toISOString();
  const runId = `wf-${args.workflow.id}-${compactTimestamp(now)}`;
  const runDir = join(args.runsRoot, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, DEFINITION_SNAPSHOT_FILENAME),
    args.yamlText,
    "utf8",
  );
  const state = await createRunState(runDir, args.workflow, []);
  // createRunState picks its own run_id based on its own clock; normalize.
  if (state.run_id !== runId) {
    const fixed: RunState = { ...state, run_id: runId };
    await saveRunState(runDir, fixed);
    return { runDir, runId, state: fixed, definitionPinned: true };
  }
  return { runDir, runId, state, definitionPinned: true };
}

interface ResumableRun {
  runId: RunID;
  runDir: string;
  state: RunState;
}

async function findResumableRun(
  runsRoot: string,
  workflowId: string,
): Promise<ResumableRun | null> {
  let entries: string[];
  try {
    entries = await readdir(runsRoot);
  } catch {
    return null;
  }
  // Sort newest-first by name; the run-id format embeds a timestamp.
  const candidates = entries
    .filter((name) => name.startsWith(`wf-${workflowId}-`))
    .sort()
    .reverse();
  for (const name of candidates) {
    const runDir = join(runsRoot, name);
    try {
      const state = await loadRunState(runDir);
      if (isResumable(state)) return { runId: state.run_id, runDir, state };
    } catch {
      continue;
    }
  }
  return null;
}

function isResumable(state: RunState): boolean {
  return state.status !== "completed" && state.status !== "cancelled";
}

function compactTimestamp(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\..*$/, "");
}

export async function hashAndRecordInputs(
  runDir: string,
  state: RunState,
  workflow: WorkflowDefinition,
  projectRoot: string,
): Promise<RunState> {
  const inputs: Artifact[] = [];
  for (const wfInput of workflow.inputs ?? []) {
    const absPath = isAbsolute(wfInput.path)
      ? wfInput.path
      : resolve(projectRoot, wfInput.path);
    const hash = await hashFile(absPath);
    inputs.push({ name: wfInput.name, path: absPath, hash });
  }
  if (sameArtifacts(state.inputs, inputs)) return state;
  const next: RunState = {
    ...state,
    inputs,
    updated_at: new Date().toISOString(),
  };
  await saveRunState(runDir, next);
  return next;
}

function sameArtifacts(a: Artifact[], b: Artifact[]): boolean {
  if (a.length !== b.length) return false;
  const key = (x: Artifact): string => `${x.name}|${x.path}|${x.hash}`;
  const setA = new Set(a.map(key));
  for (const item of b) if (!setA.has(key(item))) return false;
  return true;
}
