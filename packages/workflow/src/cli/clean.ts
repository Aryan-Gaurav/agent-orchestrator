// `aow clean` — kill AO sessions whose branch belongs to a workflow run.
//
// Two modes:
//   `aow clean <run-id>` — kill sessions for branches matching that run.
//   `aow clean --all`    — kill every session whose branch begins with
//                          `aow-<workflow_id>-`.
//
// The branch naming convention from engine/step-runner.ts is
//   aow-<workflow_id>-<step_id>-<attempt>-<run_id>
// so a per-run match is `branch.endsWith('-' + run_id)`. We don't try to be
// clever about other layouts; if the caller used a custom `branch` on a
// step, we simply won't match it.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { AoContext } from "../ao-client.js";
import { createAoContext, killSession, listProjectSessions } from "../ao-client.js";
import * as log from "../logger.js";
import { parseWorkflowDefinition } from "../schema.js";
import type { WorkflowDefinition } from "../types.js";

export interface CleanArgs {
  workflow: WorkflowDefinition;
  aoCtx: AoContext;
  runId?: string;
  all: boolean;
}

export interface CleanResult {
  killed: string[];
  skipped: string[];
}

const STEP_BRANCH_PREFIX = "aow-";

export async function runClean(args: CleanArgs): Promise<CleanResult> {
  if (!args.all && !args.runId) {
    throw new Error("aow clean requires either a <run-id> or --all");
  }
  if (args.all && args.runId) {
    throw new Error("aow clean: pass <run-id> OR --all, not both");
  }

  const workflowPrefix = `${STEP_BRANCH_PREFIX}${args.workflow.id}-`;
  const runSuffix = args.runId ? `-${args.runId}` : null;
  const sessions = await listProjectSessions(args.aoCtx);
  const killed: string[] = [];
  const skipped: string[] = [];

  for (const session of sessions) {
    const branch = session.branch ?? "";
    if (!branch.startsWith(workflowPrefix)) {
      skipped.push(session.id);
      continue;
    }
    if (runSuffix !== null && !branch.endsWith(runSuffix)) {
      skipped.push(session.id);
      continue;
    }
    try {
      await killSession(args.aoCtx, session.id, "auto_cleanup");
      killed.push(session.id);
      log.info(`killed session ${session.id} (branch ${branch})`);
    } catch (err) {
      log.warn(
        `failed to kill session ${session.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      skipped.push(session.id);
    }
  }
  return { killed, skipped };
}

export interface CleanCmdOpts {
  json?: boolean;
  workflowFile?: string;
  all?: boolean;
  aoContextFactory?: (projectId: string) => Promise<AoContext>;
}

/** CLI entry point — loads the workflow file and runs `runClean`. */
export async function cleanCmd(
  runId: string | undefined,
  opts: CleanCmdOpts,
): Promise<CleanResult> {
  const workflowPath = opts.workflowFile
    ? resolve(opts.workflowFile)
    : resolve(process.cwd(), "workflow.yaml");
  const text = await readFile(workflowPath, "utf8");
  const workflow = parseWorkflowDefinition(text);
  const factory = opts.aoContextFactory ?? createAoContext;
  const aoCtx = await factory(workflow.project_id);
  return runClean({ workflow, aoCtx, runId, all: opts.all === true });
}
