// Poll loop that decides when an agent step is "done".
//
// AO has no first-class "this prompt is finished" signal, so per
// docs/workflow-engine.md §4 we use a two-check contract:
//   1. All declared output files exist at their declared paths
//   2. Activity has been idle (idle/ready/exited) for ≥ idleThresholdMs
//
// When both hold we hash the outputs and return them. If wall-clock exceeds
// timeoutMs we surface a timeout. If the AO session goes terminal before
// outputs appear we surface a failure with reason.

import { access, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

import type {
  AoContext,
  SessionId,
  SessionStatusSnapshot,
} from "./ao-client.js";
import { getSessionStatus } from "./ao-client.js";
import type { ArtifactRef } from "./types.js";

export interface WaitForStepCompletionOptions {
  ctx: AoContext;
  sessionId: SessionId;
  expectedOutputs: ArtifactRef[];
  artifactsDir: string;
  timeoutMs: number;
  idleThresholdMs?: number;
  pollIntervalMs?: number;
  spawnGraceMs?: number;
}

export type CompletionResult =
  | { kind: "completed"; outputs: Array<{ name: string; path: string; hash: string }> }
  | { kind: "timeout"; reason: string }
  | { kind: "failed"; reason: string };

const DEFAULT_IDLE_THRESHOLD_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 10_000;
export const DEFAULT_SPAWN_GRACE_MS = 30_000;

const IDLE_ACTIVITY_STATES = new Set(["idle", "ready", "exited"]);
const TERMINAL_STATUSES = new Set(["done", "terminated", "killed", "errored"]);
// Statuses that indicate the session has progressed past spawn-time setup.
// `activity === "exited"` only counts as a real exit signal once one of these
// has been observed — before then, "exited" is just "PTY not yet attached".
const POST_SPAWN_STATUSES = new Set([
  "working",
  "idle",
  "needs_input",
  "stuck",
  "detecting",
  "done",
  "terminated",
]);

export async function waitForStepCompletion(
  opts: WaitForStepCompletionOptions,
): Promise<CompletionResult> {
  const idleThresholdMs = opts.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const spawnGraceMs = opts.spawnGraceMs ?? DEFAULT_SPAWN_GRACE_MS;
  const start = Date.now();

  let idleSince: number | null = null;

  // Loop until success / failure / timeout. Each iteration is one poll tick;
  // the sleep at the end is what makes this a polling loop rather than a busy
  // wait. The terminal-status / outputs / idle checks live above the sleep so
  // a step that's already done returns on the first tick.
  for (;;) {
    const snapshot = await getSessionStatus(opts.ctx, opts.sessionId);
    const outputsExist = await allOutputsExist(opts.artifactsDir, opts.expectedOutputs);

    if (isTerminalSnapshot(snapshot, start, spawnGraceMs) && !outputsExist) {
      return {
        kind: "failed",
        reason: failureReason(snapshot, opts.sessionId),
      };
    }

    if (outputsExist) {
      if (snapshot && isIdleActivity(snapshot.activity)) {
        if (idleSince === null) idleSince = Date.now();
        if (Date.now() - idleSince >= idleThresholdMs) {
          const outputs = await hashOutputs(opts.artifactsDir, opts.expectedOutputs);
          return { kind: "completed", outputs };
        }
      } else {
        idleSince = null;
      }
    } else {
      idleSince = null;
    }

    if (Date.now() - start >= opts.timeoutMs) {
      return {
        kind: "timeout",
        reason: outputsExist
          ? `Outputs present but activity never settled to idle within ${opts.timeoutMs}ms`
          : `Outputs not produced within ${opts.timeoutMs}ms`,
      };
    }

    await sleep(pollIntervalMs);
  }
}

export function isTerminalSnapshot(
  snapshot: SessionStatusSnapshot | null,
  startedAt: number,
  spawnGraceMs: number,
): boolean {
  if (!snapshot) {
    // A vanished session is terminal — but during the spawn grace window the
    // session may simply not be registered yet, so don't classify it as dead.
    return Date.now() - startedAt >= spawnGraceMs;
  }
  if (TERMINAL_STATUSES.has(snapshot.status)) return true;
  // `activity === "exited"` is the default for the first poll of a fresh
  // claude-code session — the PTY hasn't attached yet. Only treat it as a
  // real exit signal once the session has reached a post-spawn status.
  if (snapshot.activity === "exited" && POST_SPAWN_STATUSES.has(snapshot.status)) {
    return true;
  }
  return false;
}

function isIdleActivity(activity: string | null): boolean {
  return activity !== null && IDLE_ACTIVITY_STATES.has(activity);
}

function failureReason(snapshot: SessionStatusSnapshot | null, sessionId: SessionId): string {
  if (!snapshot) return `Session ${sessionId} no longer exists (outputs missing)`;
  return `Session ${sessionId} reached terminal status '${snapshot.status}' (activity=${snapshot.activity ?? "null"}) before producing outputs`;
}

async function allOutputsExist(
  artifactsDir: string,
  outputs: ArtifactRef[],
): Promise<boolean> {
  for (const ref of outputs) {
    const abs = join(artifactsDir, ref.path);
    try {
      await access(abs);
    } catch {
      return false;
    }
  }
  return true;
}

async function hashOutputs(
  artifactsDir: string,
  outputs: ArtifactRef[],
): Promise<Array<{ name: string; path: string; hash: string }>> {
  const results: Array<{ name: string; path: string; hash: string }> = [];
  for (const ref of outputs) {
    const abs = join(artifactsDir, ref.path);
    const buf = await readFile(abs);
    const hash = createHash("sha256").update(buf).digest("hex");
    results.push({ name: ref.name, path: abs, hash });
  }
  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
