#!/usr/bin/env node
// aow CLI entry. Thin wrappers around runWorkflow / decideGate / state-store
// reads. Output is formatted via logger (chalk to stderr; JSON when AOW_JSON=1
// or --json is passed).

import { readFile, readdir, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Command } from "commander";

import { decideGate, readPendingGates } from "./approvals.js";
import { createAoContext, type AoContext } from "./ao-client.js";
import { ensureAowConfig } from "./cli/bootstrap.js";
import { warnIfBuildStale } from "./cli/build-freshness.js";
import { cleanCmd as runCleanCmd, runClean, type CleanCmdOpts } from "./cli/clean.js";
import { ensureDaemonRunning } from "./cli/daemon-check.js";
import { emitHopsForRun } from "./cli/render-hops.js";
import { runWorkflow } from "./engine.js";
import { WorkflowError } from "./errors.js";
import * as log from "./logger.js";
import { parseWorkflowDefinition } from "./schema.js";
import { loadRunState } from "./state-store.js";
import type {
  ApprovalStep,
  RunID,
  Selector,
  StepID,
  WorkflowDefinition,
} from "./types.js";

const RUNS_DIR = ".workflow-state/runs";

interface GlobalOpts {
  json?: boolean;
  workflowFile?: string;
}

function applyGlobalOpts(opts: GlobalOpts): void {
  if (opts.json) process.env.AOW_JSON = "1";
}

interface RunCommandOpts extends GlobalOpts {
  only?: string;
  from?: string;
  to?: string;
  through?: string;
  rerun?: string;
  input?: string[];
  detach?: boolean;
  keepSessions?: boolean;
}

function buildSelector(opts: RunCommandOpts): Selector {
  const set = ["only", "from", "to", "through", "rerun"].filter(
    (k) => (opts as Record<string, unknown>)[k],
  );
  if (set.length > 1) {
    throw new Error(`Only one selector flag at a time: got ${set.join(", ")}`);
  }
  if (opts.only) return { kind: "only", stepId: opts.only };
  if (opts.from) return { kind: "from", stepId: opts.from };
  if (opts.to) return { kind: "to", stepId: opts.to };
  if (opts.through) return { kind: "through", stepId: opts.through };
  if (opts.rerun) return { kind: "rerun", stepId: opts.rerun };
  return { kind: "all" };
}

function resolveWorkflowFile(opts: GlobalOpts, _workflowId?: string): string {
  if (opts.workflowFile) return resolve(opts.workflowFile);
  return resolve(process.cwd(), "workflow.yaml");
}

async function loadWorkflow(path: string): Promise<WorkflowDefinition> {
  const text = await readFile(path, "utf8");
  return parseWorkflowDefinition(text);
}

async function findRunDir(runId: RunID, baseHint?: string): Promise<string> {
  const base = baseHint ?? join(process.cwd(), RUNS_DIR);
  const candidate = join(base, runId);
  await stat(candidate);
  return candidate;
}

async function findLatestRunDir(): Promise<string | null> {
  const base = join(process.cwd(), RUNS_DIR);
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    return null;
  }
  const dirs = entries.filter((e) => e.startsWith("wf-")).sort().reverse();
  if (dirs.length === 0) return null;
  return join(base, dirs[0]);
}

function emitResult(label: string, payload: Record<string, unknown>): void {
  if (log.isJsonMode()) {
    process.stdout.write(`${JSON.stringify({ result: label, ...payload })}\n`);
  } else {
    log.success(`${label}: ${JSON.stringify(payload)}`);
  }
}

async function runCmd(workflowId: string | undefined, opts: RunCommandOpts): Promise<void> {
  applyGlobalOpts(opts);
  const bootstrap = await ensureAowConfig(process.cwd());
  if (bootstrap.created) {
    log.info(
      `Created agent-orchestrator.yaml at ${bootstrap.configPath} — registered project ${bootstrap.projectId}.`,
    );
  }
  await ensureDaemonRunning();
  const workflowPath = resolveWorkflowFile(opts, workflowId);
  const selector = buildSelector(opts);
  const result = await runWorkflow({
    workflowPath,
    selector,
    detach: opts.detach === true,
  });
  const sweep = await maybeSweepRunSessions({
    runId: result.runId,
    status: result.status,
    workflowPath,
    detach: opts.detach === true,
    keepSessions: opts.keepSessions === true,
  });
  emitResult("run", {
    run_id: result.runId,
    status: result.status,
    awaiting_approvals: result.awaitingApprovals,
    failed: result.failed,
    sessions_killed: sweep.killed,
  });
}

export interface SweepDecisionOpts {
  detach: boolean;
  keepSessions: boolean;
}

export function shouldSweepAfterRun(opts: SweepDecisionOpts, status: string): boolean {
  if (opts.keepSessions) return false;
  if (opts.detach) return false;
  return status === "completed" || status === "failed";
}

export interface MaybeSweepArgs extends SweepDecisionOpts {
  runId: RunID;
  status: string;
  workflowPath: string;
  aoContextFactory?: (projectId: string) => Promise<AoContext>;
}

export async function maybeSweepRunSessions(args: MaybeSweepArgs): Promise<{ killed: string[] }> {
  if (!shouldSweepAfterRun(args, args.status)) return { killed: [] };
  try {
    const workflow = await loadWorkflow(args.workflowPath);
    const factory = args.aoContextFactory ?? createAoContext;
    const aoCtx = await factory(workflow.project_id);
    const result = await runClean({
      workflow,
      aoCtx,
      runId: args.runId,
      all: false,
    });
    if (result.killed.length > 0) {
      log.info(`end-of-run sweep killed ${result.killed.length} session(s) for ${args.runId}`);
    }
    return { killed: result.killed };
  } catch (err) {
    log.warn(
      `end-of-run sweep failed for ${args.runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { killed: [] };
  }
}

async function resumeCmd(runId: RunID, opts: GlobalOpts): Promise<void> {
  applyGlobalOpts(opts);
  const workflowPath = resolveWorkflowFile(opts);
  const result = await runWorkflow({
    workflowPath,
    runId,
    selector: { kind: "all" },
  });
  emitResult("resume", {
    run_id: result.runId,
    status: result.status,
    awaiting_approvals: result.awaitingApprovals,
    failed: result.failed,
  });
}

async function statusCmd(runId: RunID | undefined, opts: GlobalOpts): Promise<void> {
  applyGlobalOpts(opts);
  let runDir: string;
  if (runId) {
    runDir = await findRunDir(runId);
  } else {
    const latest = await findLatestRunDir();
    if (!latest) {
      log.warn("no runs found in ./.workflow-state/runs");
      return;
    }
    runDir = latest;
  }
  const state = await loadRunState(runDir);
  const pending = await readPendingGates(runDir);
  emitResult("status", {
    run_id: state.run_id,
    workflow_id: state.workflow_id,
    status: state.status,
    started_at: state.started_at,
    updated_at: state.updated_at,
    steps: state.steps,
    pending_gates: pending,
  });
}

async function approveCmd(runId: RunID, stepId: StepID, opts: GlobalOpts): Promise<void> {
  applyGlobalOpts(opts);
  const runDir = await findRunDir(runId);
  await decideGate(runDir, stepId, { kind: "approve" });
  emitResult("approve", { run_id: runId, step_id: stepId });
}

interface RejectOpts extends GlobalOpts {
  message: string;
}

async function rejectCmd(
  runId: RunID,
  stepId: StepID,
  opts: RejectOpts,
): Promise<void> {
  applyGlobalOpts(opts);
  const runDir = await findRunDir(runId);
  const workflowPath = resolveWorkflowFile(opts);
  const workflow = await loadWorkflow(workflowPath);
  const step = workflow.steps.find((s) => s.id === stepId);
  if (!step || step.type !== "human_approval") {
    throw new Error(`Step "${stepId}" is not a human_approval step`);
  }
  const approvalStep = step as ApprovalStep;
  await decideGate(runDir, stepId, {
    kind: "reject",
    feedback: opts.message,
    onRejectTarget: approvalStep.on_reject,
  });
  emitResult("reject", {
    run_id: runId,
    step_id: stepId,
    on_reject_target: approvalStep.on_reject,
  });
}

interface ShowOpts extends GlobalOpts {
  step?: StepID;
  hops?: boolean;
  aoContextFactory?: (projectId: string) => Promise<AoContext>;
}

export async function showCmd(runId: RunID, opts: ShowOpts): Promise<void> {
  applyGlobalOpts(opts);
  const runDir = await findRunDir(runId);
  const state = await loadRunState(runDir);
  if (opts.hops) {
    const factory = opts.aoContextFactory ?? createAoContext;
    const workflow = await loadWorkflow(resolveWorkflowFile(opts));
    const aoCtx = await factory(workflow.project_id);
    await emitHopsForRun({
      runId, state, aoCtx, cwd: process.cwd(),
      filterStep: opts.step, jsonMode: log.isJsonMode(), emitResult,
    });
    return;
  }
  if (opts.step) {
    const step = state.steps[opts.step];
    if (!step) throw new Error(`Step "${opts.step}" not found in run ${runId}`);
    emitResult("show-step", { run_id: runId, step_id: opts.step, ...step });
    return;
  }
  emitResult("show", { ...state });
}

async function listCmd(opts: GlobalOpts): Promise<void> {
  applyGlobalOpts(opts);
  const cwd = process.cwd();
  const found: string[] = [];
  const main = join(cwd, "workflow.yaml");
  try {
    await stat(main);
    found.push(main);
  } catch {
    // ignore
  }
  const workflowsDir = join(cwd, "workflows");
  try {
    const entries = await readdir(workflowsDir);
    for (const entry of entries) {
      if (entry.endsWith(".yaml") || entry.endsWith(".yml")) {
        found.push(join(workflowsDir, entry));
      }
    }
  } catch {
    // ignore
  }

  const summaries: Array<{ id: string; path: string; description?: string }> = [];
  for (const path of found) {
    try {
      const text = await readFile(path, "utf8");
      const def = parseWorkflowDefinition(text);
      summaries.push({ id: def.id, path, description: def.description });
    } catch (err) {
      log.warn(
        `failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  emitResult("list", { workflows: summaries });
}

async function runsCmd(opts: GlobalOpts): Promise<void> {
  applyGlobalOpts(opts);
  const base = join(process.cwd(), RUNS_DIR);
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    emitResult("runs", { runs: [] });
    return;
  }
  const summaries: Array<{
    run_id: string; workflow_id: string; status: string; updated_at: string;
  }> = [];
  for (const entry of entries) {
    if (!entry.startsWith("wf-")) continue;
    const runDir = join(base, entry);
    try {
      const state = await loadRunState(runDir);
      summaries.push({
        run_id: state.run_id, workflow_id: state.workflow_id,
        status: state.status, updated_at: state.updated_at,
      });
    } catch {
      // skip corrupt run dirs
    }
  }
  summaries.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  emitResult("runs", { runs: summaries });
}

export async function cleanCmd(runId: string | undefined, opts: CleanCmdOpts): Promise<void> {
  applyGlobalOpts(opts);
  const result = await runCleanCmd(runId, opts);
  emitResult("clean", {
    killed: result.killed,
    skipped_count: result.skipped.length,
  });
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name("aow")
    .description("Workflow engine CLI for agent-orchestrator")
    .version("0.0.1");

  program
    .option("--json", "emit machine-readable JSON output")
    .option("--workflow-file <path>", "override workflow.yaml location (default: ./workflow.yaml)");

  program
    .command("run [workflow]")
    .description("Run a workflow (or resume the latest run for it)")
    .option("--only <step>", "run only this step")
    .option("--from <step>", "run this step and everything downstream")
    .option("--to <step>", "run everything up to and including this step")
    .option("--through <step>", "run this step plus its missing upstream deps")
    .option("--rerun <step>", "force re-run of a completed step")
    .option("--input <name=path...>", "inject an external artifact under a name")
    .option("--detach", "exit after first awaiting gate instead of blocking")
    .option("--keep-sessions", "skip end-of-run AO session sweep (default: kill on completed/failed)")
    .action(async (workflow: string | undefined, cmdOpts: Record<string, unknown>, command) => {
      const merged = { ...command.parent?.opts(), ...cmdOpts } as RunCommandOpts;
      await runCmd(workflow, merged);
    });

  program
    .command("resume <run-id>")
    .description("Continue a previously started run")
    .action(async (runId: RunID, _cmdOpts: Record<string, unknown>, command) => {
      const merged = { ...command.parent?.opts() } as GlobalOpts;
      await resumeCmd(runId, merged);
    });

  program
    .command("status [run-id]")
    .description("Show status summary for a run (default: latest)")
    .action(async (runId: RunID | undefined, _cmdOpts: Record<string, unknown>, command) => {
      const merged = { ...command.parent?.opts() } as GlobalOpts;
      await statusCmd(runId, merged);
    });

  program
    .command("approve <run-id> <step-id>")
    .description("Approve a waiting human_approval gate")
    .action(async (runId: RunID, stepId: StepID, _cmdOpts: Record<string, unknown>, command) => {
      const merged = { ...command.parent?.opts() } as GlobalOpts;
      await approveCmd(runId, stepId, merged);
    });

  program
    .command("reject <run-id> <step-id>")
    .description("Reject a waiting human_approval gate with feedback")
    .requiredOption("-m, --message <text>", "feedback to attach to the rejection")
    .action(async (runId: RunID, stepId: StepID, cmdOpts: Record<string, unknown>, command) => {
      const merged = { ...command.parent?.opts(), ...cmdOpts } as RejectOpts;
      await rejectCmd(runId, stepId, merged);
    });

  program
    .command("show <run-id>")
    .description("Show run or step details")
    .option("--step <id>", "show details for a specific step")
    .option("--hops", "show citation hop trails per step (reads .ao/ref-hops.jsonl)")
    .action(async (runId: RunID, cmdOpts: Record<string, unknown>, command) => {
      const merged = { ...command.parent?.opts(), ...cmdOpts } as ShowOpts;
      await showCmd(runId, merged);
    });

  program
    .command("list")
    .description("List workflows discovered in the current directory")
    .action(async (_cmdOpts: Record<string, unknown>, command) => {
      const merged = { ...command.parent?.opts() } as GlobalOpts;
      await listCmd(merged);
    });

  program
    .command("runs")
    .description("List recent and active workflow runs")
    .action(async (_cmdOpts: Record<string, unknown>, command) => {
      const merged = { ...command.parent?.opts() } as GlobalOpts;
      await runsCmd(merged);
    });

  program
    .command("clean [run-id]")
    .description("Kill AO sessions belonging to a workflow run (or all runs of this workflow)")
    .option("--all", "kill every session for this workflow regardless of run id")
    .action(async (runId: string | undefined, cmdOpts: Record<string, unknown>, command) => {
      const merged = { ...command.parent?.opts(), ...cmdOpts } as CleanCmdOpts;
      await cleanCmd(runId, merged);
    });

  return program;
}

async function main(): Promise<void> {
  await warnIfBuildStale();
  const program = buildProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof WorkflowError) log.error(`${err.code}: ${err.message}`);
    else if (err instanceof Error) log.error(err.message);
    else log.error(String(err));
    process.exitCode = 1;
  }
}

const entry = process.argv[1];
if (entry) {
  const selfUrl = fileURLToPath(import.meta.url);
  let argvReal = entry;
  try {
    argvReal = realpathSync(entry);
  } catch {
    // entry may not exist on disk if launched via -e; fall through
  }
  if (
    import.meta.url === pathToFileURL(entry).href ||
    selfUrl === argvReal ||
    import.meta.url.endsWith(entry)
  ) {
    void main();
  }
}
