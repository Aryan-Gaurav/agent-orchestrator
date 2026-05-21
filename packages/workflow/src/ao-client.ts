// Thin facade over @aoagents/ao-core. By convention, this is the ONLY module
// in @aoagents/ao-workflow that imports from ao-core — the rest of the engine
// talks to AO through this surface so the dependency stays inspectable.

import {
  createLifecycleManager,
  createPluginRegistry,
  createSessionManager,
  loadConfig,
  type ActivityState,
  type LifecycleManager,
  type OrchestratorConfig,
  type Session,
  type SessionId,
  type SessionManager,
  type SessionStatus,
  type LifecycleKillReason,
} from "@aoagents/ao-core";

import { AoContextError } from "./errors.js";

export type { ActivityState, SessionId, SessionStatus, LifecycleKillReason };

export interface AoContext {
  sm: SessionManager;
  lm: LifecycleManager;
  config: OrchestratorConfig;
}

export interface SpawnAgentOptions {
  projectId: string;
  agent: string;
  branch: string;
  prompt: string;
}

export interface SpawnAgentResult {
  sessionId: SessionId;
  branch: string;
}

export interface SessionStatusSnapshot {
  status: SessionStatus;
  activity: ActivityState | null;
  lastActivityAt: string | null;
}

const contextCache = new Map<string, Promise<AoContext>>();

/**
 * Build an AoContext for a project: load orchestrator config, register
 * built-in plugins, and wire up session + lifecycle managers. Cached per
 * projectId because plugin registry construction is heavyweight (it scans
 * the AO plugin store + workspace deps).
 */
export async function createAoContext(projectId: string): Promise<AoContext> {
  let pending = contextCache.get(projectId);
  if (!pending) {
    pending = buildAoContext(projectId).catch((err) => {
      contextCache.delete(projectId);
      throw err;
    });
    contextCache.set(projectId, pending);
  }
  return pending;
}

async function buildAoContext(projectId: string): Promise<AoContext> {
  let config: OrchestratorConfig;
  try {
    config = await loadConfig();
  } catch (err) {
    throw new AoContextError(
      `Failed to load AO orchestrator config for project '${projectId}'`,
      { cause: err },
    );
  }

  if (!config.projects[projectId]) {
    throw new AoContextError(
      `Project '${projectId}' not found in AO config (${config.configPath})`,
    );
  }

  const registry = createPluginRegistry();
  try {
    await registry.loadFromConfig(config);
  } catch (err) {
    throw new AoContextError(
      `Failed to load AO plugins from config for project '${projectId}'`,
      { cause: err },
    );
  }

  const sm = createSessionManager({ config, registry });
  const lm = createLifecycleManager({ config, registry, sessionManager: sm, projectId });

  return { sm, lm, config };
}

/** Test-only helper to drop the per-projectId context cache. */
export function _resetAoContextCacheForTests(): void {
  contextCache.clear();
}

/**
 * Spawn an AO agent session for a workflow step.
 *
 * Match the cli/spawn semantics: passing `agent` and `branch` overrides
 * the project defaults, and `prompt` is delivered to the agent as its
 * initial user prompt.
 */
export async function spawnAgentSession(
  ctx: AoContext,
  opts: SpawnAgentOptions,
): Promise<SpawnAgentResult> {
  const session = await ctx.sm.spawn({
    projectId: opts.projectId,
    agent: opts.agent,
    branch: opts.branch,
    prompt: opts.prompt,
  });

  return {
    sessionId: session.id,
    branch: session.branch ?? opts.branch,
  };
}

/**
 * Read the current status of an AO session. Returns `null` if the session
 * no longer exists. The completion-detector reads this on every poll tick.
 */
export async function getSessionStatus(
  ctx: AoContext,
  sessionId: SessionId,
): Promise<SessionStatusSnapshot | null> {
  const session: Session | null = await ctx.sm.get(sessionId);
  if (!session) return null;
  return {
    status: session.status,
    activity: session.activity,
    lastActivityAt: session.lastActivityAt ? session.lastActivityAt.toISOString() : null,
  };
}

/** Kill an AO session, surfacing the workflow-engine kill reason (if any). */
export async function killSession(
  ctx: AoContext,
  sessionId: SessionId,
  reason?: LifecycleKillReason,
): Promise<void> {
  await ctx.sm.kill(sessionId, reason ? { reason } : undefined);
}

/**
 * Look up a session's filesystem workspace path. Returns null if the
 * session no longer exists. Used by the workflow engine to drop the
 * resolver script into the agent's worktree post-spawn.
 */
export async function getSessionWorkspacePath(
  ctx: AoContext,
  sessionId: SessionId,
): Promise<string | null> {
  const session = await ctx.sm.get(sessionId);
  if (!session) return null;
  return session.workspacePath ?? null;
}
