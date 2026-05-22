import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { LockTimeoutError, StateStoreError } from "./errors.js";
import type {
  Artifact,
  RunState,
  StepID,
  StepState,
  WorkflowDefinition,
} from "./types.js";

const STATE_FILENAME = "state.json";
const STATE_TMP_FILENAME = "state.json.tmp";
const LOCK_FILENAME = ".state.lock";

const LOCK_INITIAL_BACKOFF_MS = 10;
const LOCK_MAX_BACKOFF_MS = 200;
const LOCK_MAX_WAIT_MS = 2_000;

const artifactSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  hash: z.string().min(1),
});

const lintFindingSchema = z.object({
  kind: z.enum(["error", "warning"]),
  code: z.string().min(1),
  outputFile: z.string().min(1),
  ref: z.string().optional(),
  claim: z.string().optional(),
  message: z.string().min(1),
  detail: z.string().optional(),
});

const lintReportSchema = z.object({
  errors: z.array(lintFindingSchema),
  warnings: z.array(lintFindingSchema),
});

const attemptRecordSchema = z.object({
  session_id: z.string().min(1),
  branch: z.string().min(1),
  started_at: z.string().min(1),
  completed_at: z.string().min(1).optional(),
  inputs: z.array(artifactSchema),
  outputs: z.array(artifactSchema),
  lint_report: lintReportSchema.optional(),
});

const stepStatusSchema = z.enum([
  "pending",
  "running",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
  "stale",
]);

const stepStateSchema = z.object({
  status: stepStatusSchema,
  attempts: z.number().int().nonnegative().optional(),
  current_attempt: attemptRecordSchema.optional(),
  history: z.array(attemptRecordSchema).optional(),
  awaiting_since: z.string().min(1).optional(),
  failure_reason: z.string().min(1).optional(),
  warnings: z.array(z.string().min(1)).optional(),
});

const runStateSchema = z.object({
  run_id: z.string().min(1),
  workflow_id: z.string().min(1),
  started_at: z.string().min(1),
  updated_at: z.string().min(1),
  status: stepStatusSchema,
  inputs: z.array(artifactSchema),
  steps: z.record(z.string().min(1), stepStateSchema),
});

export { runStateSchema };

export async function loadRunState(runDir: string): Promise<RunState> {
  const statePath = join(runDir, STATE_FILENAME);
  let raw: string;
  try {
    raw = await readFile(statePath, "utf8");
  } catch (err) {
    throw new StateStoreError(`Failed to read state at ${statePath}`, {
      cause: err instanceof Error ? err : undefined,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new StateStoreError(`Corrupt state.json at ${statePath}`, {
      cause: err instanceof Error ? err : undefined,
    });
  }

  const result = runStateSchema.safeParse(parsed);
  if (!result.success) {
    const messages = result.error.issues
      .map((issue) => {
        const path = issue.path.length === 0 ? "(root)" : issue.path.join(".");
        return `${path}: ${issue.message}`;
      })
      .join("; ");
    throw new StateStoreError(
      `state.json at ${statePath} failed validation: ${messages}`,
      { cause: result.error },
    );
  }
  return result.data as RunState;
}

export async function saveRunState(
  runDir: string,
  state: RunState,
): Promise<void> {
  const validated = runStateSchema.safeParse(state);
  if (!validated.success) {
    throw new StateStoreError(
      `Refusing to save invalid RunState: ${validated.error.message}`,
      { cause: validated.error },
    );
  }

  const finalPath = join(runDir, STATE_FILENAME);
  const tmpPath = join(runDir, STATE_TMP_FILENAME);
  const body = `${JSON.stringify(state, null, 2)}\n`;

  try {
    await writeFile(tmpPath, body, { encoding: "utf8" });
  } catch (err) {
    throw new StateStoreError(`Failed to write temp state at ${tmpPath}`, {
      cause: err instanceof Error ? err : undefined,
    });
  }

  try {
    await rename(tmpPath, finalPath);
  } catch (err) {
    // Best-effort cleanup of leftover temp file before surfacing the error.
    await unlink(tmpPath).catch(() => undefined);
    throw new StateStoreError(
      `Failed to rename temp state ${tmpPath} -> ${finalPath}`,
      { cause: err instanceof Error ? err : undefined },
    );
  }
}

export async function createRunState(
  runDir: string,
  workflow: WorkflowDefinition,
  initialInputs: Artifact[],
): Promise<RunState> {
  const now = new Date().toISOString();
  const steps: Record<StepID, StepState> = {};
  for (const step of workflow.steps) {
    steps[step.id] = { status: "pending" };
  }
  const state: RunState = {
    run_id: deriveRunId(workflow.id, now),
    workflow_id: workflow.id,
    started_at: now,
    updated_at: now,
    status: "pending",
    inputs: initialInputs,
    steps,
  };
  await saveRunState(runDir, state);
  return state;
}

export async function updateStep(
  runDir: string,
  stepId: StepID,
  updater: (prev: StepState) => StepState,
): Promise<RunState> {
  const lockPath = join(runDir, LOCK_FILENAME);
  await acquireLock(lockPath);
  try {
    const state = await loadRunState(runDir);
    const prev = state.steps[stepId];
    if (!prev) {
      throw new StateStoreError(
        `Cannot update unknown step "${stepId}" in run ${state.run_id}`,
      );
    }
    const next = updater(prev);
    const updatedState: RunState = {
      ...state,
      updated_at: new Date().toISOString(),
      steps: { ...state.steps, [stepId]: next },
    };
    await saveRunState(runDir, updatedState);
    return updatedState;
  } finally {
    await releaseLock(lockPath);
  }
}

async function acquireLock(lockPath: string): Promise<void> {
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  let backoff = LOCK_INITIAL_BACKOFF_MS;
  let lastError: unknown = undefined;
  while (Date.now() <= deadline) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
      } finally {
        await handle.close();
      }
      return;
    } catch (err) {
      lastError = err;
      if (!isEexist(err)) {
        throw new StateStoreError(`Failed to acquire lock at ${lockPath}`, {
          cause: err instanceof Error ? err : undefined,
        });
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const wait = Math.min(backoff, remaining, LOCK_MAX_BACKOFF_MS);
      await sleep(wait);
      backoff = Math.min(backoff * 2, LOCK_MAX_BACKOFF_MS);
    }
  }
  throw new LockTimeoutError(lockPath, {
    cause: lastError instanceof Error ? lastError : undefined,
  });
}

async function releaseLock(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch (err) {
    // ENOENT means another holder removed it; anything else is unexpected.
    if (!isEnoent(err)) {
      throw new StateStoreError(`Failed to release lock at ${lockPath}`, {
        cause: err instanceof Error ? err : undefined,
      });
    }
  }
}

function isEexist(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "EEXIST"
  );
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function deriveRunId(workflowId: string, isoTimestamp: string): string {
  const compact = isoTimestamp.replace(/[-:]/g, "").replace(/\..*$/, "");
  return `wf-${workflowId}-${compact}`;
}
