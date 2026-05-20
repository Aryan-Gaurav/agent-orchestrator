// File-based human approval gate handshake.
//
// Engine writes pending/<step>.json + sets state.awaiting_approval. A separate
// `aow approve` / `aow reject` invocation calls decideGate, which updates state
// and removes the pending file. The engine (in blocking mode) polls state to
// notice the decision.

import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { GateNotAwaitingError, StateStoreError } from "./errors.js";
import { loadRunState, updateStep } from "./state-store.js";
import type { StepID } from "./types.js";

export interface PendingGate {
  step_id: StepID;
  message: string;
  awaiting_since: string;
  artifacts_to_review: string[];
}

export type GateDecision =
  | { kind: "approve" }
  | { kind: "reject"; feedback: string; onRejectTarget: StepID };

const PENDING_DIR = "pending";
const FEEDBACK_DIR = "feedback";

function pendingPath(runDir: string, stepId: StepID): string {
  return join(runDir, PENDING_DIR, `${stepId}.json`);
}

function feedbackPath(runDir: string, stepId: StepID, attempt: number): string {
  return join(runDir, FEEDBACK_DIR, `${stepId}-attempt-${attempt}.md`);
}

export async function enterGate(
  runDir: string,
  stepId: StepID,
  message: string,
  artifacts: string[],
): Promise<void> {
  const awaitingSince = new Date().toISOString();
  const record: PendingGate = {
    step_id: stepId,
    message,
    awaiting_since: awaitingSince,
    artifacts_to_review: artifacts,
  };

  await mkdir(join(runDir, PENDING_DIR), { recursive: true });

  const filePath = pendingPath(runDir, stepId);
  try {
    await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  } catch (err) {
    throw new StateStoreError(`Failed to write pending gate at ${filePath}`, {
      cause: err instanceof Error ? err : undefined,
    });
  }

  await updateStep(runDir, stepId, (prev) => ({
    ...prev,
    status: "awaiting_approval",
    awaiting_since: awaitingSince,
  }));
}

export async function decideGate(
  runDir: string,
  stepId: StepID,
  decision: GateDecision,
): Promise<void> {
  const state = await loadRunState(runDir);
  const step = state.steps[stepId];
  if (!step) {
    throw new GateNotAwaitingError(stepId, "missing");
  }
  if (step.status !== "awaiting_approval") {
    throw new GateNotAwaitingError(stepId, step.status);
  }

  if (decision.kind === "approve") {
    await updateStep(runDir, stepId, (prev) => ({
      ...prev,
      status: "completed",
      awaiting_since: undefined,
    }));
    await removePendingFile(runDir, stepId);
    return;
  }

  // Rejection: attach feedback to the on_reject target, reset both the target
  // and the gate to pending so the engine re-runs the target then the gate.
  const target = decision.onRejectTarget;
  const targetState = state.steps[target];
  if (!targetState) {
    throw new StateStoreError(
      `decideGate(reject): on_reject target "${target}" missing from run state`,
    );
  }

  await mkdir(join(runDir, FEEDBACK_DIR), { recursive: true });
  const nextAttempt = (targetState.attempts ?? 0) + 1;
  const feedbackFile = feedbackPath(runDir, target, nextAttempt);
  try {
    await writeFile(feedbackFile, decision.feedback, "utf8");
  } catch (err) {
    throw new StateStoreError(`Failed to write feedback at ${feedbackFile}`, {
      cause: err instanceof Error ? err : undefined,
    });
  }

  await updateStep(runDir, target, (prev) => {
    const history = prev.current_attempt
      ? [...(prev.history ?? []), prev.current_attempt]
      : (prev.history ?? []);
    return {
      ...prev,
      status: "pending",
      current_attempt: undefined,
      history,
      failure_reason: undefined,
    };
  });

  await updateStep(runDir, stepId, (prev) => ({
    ...prev,
    status: "pending",
    attempts: (prev.attempts ?? 0) + 1,
    awaiting_since: undefined,
  }));

  await removePendingFile(runDir, stepId);
}

export async function readPendingGates(runDir: string): Promise<PendingGate[]> {
  const dir = join(runDir, PENDING_DIR);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw new StateStoreError(`Failed to list pending gates at ${dir}`, {
      cause: err instanceof Error ? err : undefined,
    });
  }

  const gates: PendingGate[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = join(dir, entry);
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as PendingGate;
      gates.push(parsed);
    } catch (err) {
      throw new StateStoreError(`Failed to read pending gate ${basename(filePath)}`, {
        cause: err instanceof Error ? err : undefined,
      });
    }
  }
  return gates;
}

export async function readFeedback(
  runDir: string,
  stepId: StepID,
  attempt: number,
): Promise<string | null> {
  try {
    return await readFile(feedbackPath(runDir, stepId, attempt), "utf8");
  } catch (err) {
    if (isEnoent(err)) return null;
    throw new StateStoreError(`Failed to read feedback for ${stepId} attempt ${attempt}`, {
      cause: err instanceof Error ? err : undefined,
    });
  }
}

async function removePendingFile(runDir: string, stepId: StepID): Promise<void> {
  try {
    await unlink(pendingPath(runDir, stepId));
  } catch (err) {
    if (!isEnoent(err)) {
      throw new StateStoreError(`Failed to remove pending gate for ${stepId}`, {
        cause: err instanceof Error ? err : undefined,
      });
    }
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}
