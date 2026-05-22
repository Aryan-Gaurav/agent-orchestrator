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

// Resolve plugin packages from THIS file's location (packages/workflow/...),
// not from where @aoagents/ao-core lives. ao-core's plugin-registry calls
// dynamic import() from its own module path (packages/core/...), which has
// no plugins in its node_modules. The workflow package's node_modules has
// all of them via workspace symlinks. Issuing import() from here ensures
// Node resolves the bare specifier starting at packages/workflow/.
async function importPluginFromWorkflow(pkg: string): Promise<unknown> {
  return import(/* @vite-ignore */ pkg);
}

export type { ActivityState, SessionId, SessionStatus, LifecycleKillReason };

export interface AoContext {
  sm: SessionManager;
  lm: LifecycleManager;
  config: OrchestratorConfig;
  /**
   * The project id resolved against the loaded AO config (may differ from
   * the workflow's `project_id` if bootstrap added a hash suffix). Use this
   * whenever calling into AO core (spawn, lifecycle), not the user-typed
   * project_id.
   */
  projectId: string;
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

  // Resolve the project. Direct id match is the happy path. If the workflow
  // yaml's project_id doesn't match (common after bootstrap, since AO core
  // adds a hash suffix on registration), fall back to the sole project in
  // the resolved config — which loadConfig() narrowed to the cwd's
  // registered project via buildEffectiveConfigFromFlatLocalPath. The cwd
  // is the source of truth for project identity.
  const projectKeys = Object.keys(config.projects);
  const resolvedProjectId =
    config.projects[projectId] !== undefined
      ? projectId
      : projectKeys.length === 1
        ? projectKeys[0]
        : null;

  if (resolvedProjectId === null) {
    throw new AoContextError(
      `Project '${projectId}' not found in AO config (${config.configPath})`,
    );
  }

  const registry = createPluginRegistry();
  try {
    await registry.loadFromConfig(config, importPluginFromWorkflow);
  } catch (err) {
    throw new AoContextError(
      `Failed to load AO plugins from config for project '${projectId}'`,
      { cause: err },
    );
  }

  const sm = createSessionManager({ config, registry });
  const lm = createLifecycleManager({
    config,
    registry,
    sessionManager: sm,
    projectId: resolvedProjectId,
  });

  return { sm, lm, config, projectId: resolvedProjectId };
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
    projectId: ctx.projectId,
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

export interface SessionSummary {
  id: SessionId;
  branch: string | null;
}

/**
 * List AO sessions for the project. Used by `aow clean` to find sessions
 * whose branch matches a workflow's `aow-*` pattern.
 */
export async function listProjectSessions(
  ctx: AoContext,
): Promise<SessionSummary[]> {
  const sessions = await ctx.sm.list(ctx.projectId);
  return sessions.map((s) => ({ id: s.id, branch: s.branch ?? null }));
}
