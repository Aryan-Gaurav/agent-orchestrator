// Executes a single workflow step (agent or human_approval). All heavy I/O
// lives in modules called from here — completion-detector polls AO,
// artifact-store hashes, prompt-template renders, approvals handles gate
// handshake. The runner just sequences those pieces and updates state.

import { isAbsolute, join, resolve } from "node:path";

import type { AoContext } from "../ao-client.js";
import { getSessionWorkspacePath, killSession, spawnAgentSession } from "../ao-client.js";
import { installResolverScript } from "./workspace-setup.js";
import { hashFile } from "../artifact-store.js";
import { waitForStepCompletion } from "../completion-detector.js";
import { enterGate, readFeedback } from "../approvals.js";
import { RevisionLimitExceededError } from "../errors.js";
import * as log from "../logger.js";
import {
  appendExecutionContract,
  prependFeedback,
  renderPrompt,
} from "../prompt-template.js";
import { updateStep } from "../state-store.js";
import type {
  AgentStep,
  ApprovalStep,
  Artifact,
  ArtifactRef,
  RunState,
  StepID,
  WorkflowDefinition,
} from "../types.js";

const DEFAULT_TIMEOUT_MINUTES = 60;
const DEFAULT_MAX_REVISIONS = 5;

export interface StepRunContext {
  workflow: WorkflowDefinition;
  state: RunState;
  runDir: string;
  artifactsDir: string; // absolute
  projectRoot: string; // absolute; for resolving workflow-level inputs
  aoCtx: AoContext;
  completionPollIntervalMs?: number;
  completionIdleThresholdMs?: number;
}

export type StepRunOutcome =
  | { kind: "completed" }
  | { kind: "awaiting_approval" }
  | { kind: "failed"; reason: string };

export async function runAgentStep(
  ctx: StepRunContext,
  step: AgentStep,
): Promise<StepRunOutcome> {
  const inputs = await resolveAgentInputs(ctx, step);
  const outputs = resolveAgentOutputs(ctx, step);

  const renderVars = {
    inputs: mapAbsolutePaths(inputs),
    outputs: mapAbsolutePaths(outputs),
  };

  let prompt = renderPrompt(step.prompt, renderVars);
  prompt = appendExecutionContract(prompt, renderVars.outputs);

  const attempts = (ctx.state.steps[step.id]?.attempts ?? 0) + 1;
  if (attempts > 1) {
    const feedback = await readFeedback(ctx.runDir, step.id, attempts);
    if (feedback) {
      prompt = prependFeedback(prompt, feedback);
    }
  }

  const branch = step.branch ?? `aow-${ctx.workflow.id}-${step.id}-${attempts}`;
  const startedAt = new Date().toISOString();

  await updateStep(ctx.runDir, step.id, (prev) => ({
    ...prev,
    status: "running",
    attempts,
  }));

  log.step(step.id, `spawning agent=${step.agent} branch=${branch} attempt=${attempts}`);

  let sessionId: string;
  try {
    const spawn = await spawnAgentSession(ctx.aoCtx, {
      projectId: ctx.workflow.project_id,
      agent: step.agent,
      branch,
      prompt,
    });
    sessionId = spawn.sessionId;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error(`[${step.id}] spawn failed: ${reason}`);
    return { kind: "failed", reason: `spawn_failed: ${reason}` };
  }

  try {
    const workspacePath = await getSessionWorkspacePath(ctx.aoCtx, sessionId);
    if (workspacePath) {
      await installResolverScript(workspacePath);
    } else {
      log.warn(`[${step.id}] could not locate workspace for session ${sessionId}; resolver script not installed`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn(`[${step.id}] failed to install resolver script: ${reason}`);
  }

  const timeoutMs = (step.timeout_minutes ?? DEFAULT_TIMEOUT_MINUTES) * 60_000;
  const expected: ArtifactRef[] = outputs.map((o) => ({
    name: o.name,
    path: o.relPath,
  }));

  const result = await waitForStepCompletion({
    ctx: ctx.aoCtx,
    sessionId,
    expectedOutputs: expected,
    artifactsDir: ctx.artifactsDir,
    timeoutMs,
    pollIntervalMs: ctx.completionPollIntervalMs,
    idleThresholdMs: ctx.completionIdleThresholdMs,
  });

  if (result.kind === "timeout") {
    await killSession(ctx.aoCtx, sessionId, "manually_killed").catch(() => undefined);
    await recordFailedAttempt(ctx, step, sessionId, branch, startedAt, inputs, []);
    return { kind: "failed", reason: `timeout: ${result.reason}` };
  }
  if (result.kind === "failed") {
    await recordFailedAttempt(ctx, step, sessionId, branch, startedAt, inputs, []);
    return { kind: "failed", reason: result.reason };
  }

  // Completed. Persist the attempt record and mark the step completed.
  const completedAt = new Date().toISOString();
  const outputArtifacts: Artifact[] = result.outputs.map((o) => ({
    name: o.name,
    path: o.path,
    hash: o.hash,
  }));

  await updateStep(ctx.runDir, step.id, (prev) => ({
    ...prev,
    status: "completed",
    failure_reason: undefined,
    current_attempt: {
      session_id: sessionId,
      branch,
      started_at: startedAt,
      completed_at: completedAt,
      inputs: inputs.map((i) => ({ name: i.name, path: i.absPath, hash: i.hash })),
      outputs: outputArtifacts,
    },
  }));

  log.success(`[${step.id}] completed; outputs=${result.outputs.length}`);
  return { kind: "completed" };
}

export async function runApprovalStep(
  ctx: StepRunContext,
  step: ApprovalStep,
): Promise<StepRunOutcome> {
  const limit = step.max_revisions ?? DEFAULT_MAX_REVISIONS;
  const attempts = ctx.state.steps[step.id]?.attempts ?? 0;
  if (attempts > limit) {
    await updateStep(ctx.runDir, step.id, (prev) => ({
      ...prev,
      status: "failed",
      failure_reason: "revision_limit_exceeded",
    }));
    throw new RevisionLimitExceededError(step.id, limit);
  }

  const artifactsToReview = collectArtifactsForReview(ctx, step);
  await enterGate(ctx.runDir, step.id, step.message, artifactsToReview);
  log.info(`[${step.id}] awaiting approval — run "aow approve <run> ${step.id}" to proceed`);
  return { kind: "awaiting_approval" };
}

interface ResolvedInput {
  name: string;
  absPath: string;
  hash: string;
}

interface ResolvedOutput {
  name: string;
  absPath: string;
  relPath: string;
}

async function resolveAgentInputs(
  ctx: StepRunContext,
  step: AgentStep,
): Promise<ResolvedInput[]> {
  const result: ResolvedInput[] = [];

  // Workflow-level inputs are always accessible by name from any step.
  for (const wfInput of ctx.workflow.inputs ?? []) {
    const absPath = isAbsolute(wfInput.path)
      ? wfInput.path
      : resolve(ctx.projectRoot, wfInput.path);
    const hash = await hashFile(absPath);
    result.push({ name: wfInput.name, absPath, hash });
  }

  for (const [name, relPath] of Object.entries(step.inputs ?? {})) {
    const absPath = isAbsolute(relPath)
      ? relPath
      : join(ctx.artifactsDir, relPath);
    const hash = await hashFile(absPath);
    result.push({ name, absPath, hash });
  }

  return result;
}

function resolveAgentOutputs(
  ctx: StepRunContext,
  step: AgentStep,
): ResolvedOutput[] {
  const result: ResolvedOutput[] = [];
  for (const [name, relPath] of Object.entries(step.outputs)) {
    const absPath = isAbsolute(relPath)
      ? relPath
      : join(ctx.artifactsDir, relPath);
    result.push({ name, absPath, relPath });
  }
  return result;
}

function mapAbsolutePaths(
  entries: Array<{ name: string; absPath: string }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of entries) {
    out[entry.name] = entry.absPath;
  }
  return out;
}

function collectArtifactsForReview(
  ctx: StepRunContext,
  step: ApprovalStep,
): string[] {
  // Reviewer should look at the outputs of the on_reject target step.
  const target = ctx.workflow.steps.find((s) => s.id === step.on_reject);
  if (!target || target.type !== "agent") return [];
  return Object.values(target.outputs).map((rel) =>
    isAbsolute(rel) ? rel : join(ctx.artifactsDir, rel),
  );
}

async function recordFailedAttempt(
  ctx: StepRunContext,
  step: AgentStep,
  sessionId: string,
  branch: string,
  startedAt: string,
  inputs: ResolvedInput[],
  outputs: Artifact[],
): Promise<void> {
  await updateStep(ctx.runDir, step.id, (cur) => ({
    ...cur,
    status: "failed",
    current_attempt: {
      session_id: sessionId,
      branch,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      inputs: inputs.map((i) => ({ name: i.name, path: i.absPath, hash: i.hash })),
      outputs,
    },
  }));
}
