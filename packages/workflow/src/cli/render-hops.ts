// Helpers for `aow show --hops`: collect and format the per-step citation hop
// trails recorded by the resolver in `<workspacePath>/.ao/ref-hops.jsonl`.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";

import type { AoContext } from "../ao-client.js";
import { getSessionWorkspacePath } from "../ao-client.js";
import * as log from "../logger.js";
import type { RunState, StepID } from "../types.js";

interface HopEntry {
  ts: string; step_id: string; ref: string;
  outcome: string; match_kind: string | null;
}
interface StepHops { workspace: string | null; entries: HopEntry[] }
type HopsByStep = Record<StepID, StepHops>;

function isHopEntry(v: unknown): v is HopEntry {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.ts === "string" && typeof o.step_id === "string"
    && typeof o.ref === "string" && typeof o.outcome === "string"
    && (o.match_kind === null || typeof o.match_kind === "string");
}

async function readHops(ws: string, warned: { fired: boolean }): Promise<HopEntry[]> {
  const file = join(ws, ".ao", "ref-hops.jsonl");
  if (!existsSync(file)) return [];
  const out: HopEntry[] = [];
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isHopEntry(parsed)) out.push(parsed);
    } catch {
      if (warned.fired) continue;
      log.warn(`malformed hop line in ${file}; skipping further warnings`);
      warned.fired = true;
    }
  }
  return out;
}

async function collect(
  state: RunState, aoCtx: AoContext, cwd: string, filterStep?: StepID,
): Promise<HopsByStep> {
  const out: HopsByStep = {};
  const warned = { fired: false };
  for (const [stepId, st] of Object.entries(state.steps)) {
    if (filterStep && stepId !== filterStep) continue;
    const sid = st.current_attempt?.session_id;
    const ws = sid ? await getSessionWorkspacePath(aoCtx, sid).catch(() => null) : null;
    if (!ws) { out[stepId] = { workspace: null, entries: [] }; continue; }
    const entries = (await readHops(ws, warned)).filter((e) => e.step_id === stepId);
    out[stepId] = { workspace: relative(cwd, ws) || ws, entries };
  }
  return out;
}

function format(hops: HopsByStep): string {
  const lines: string[] = [];
  for (const [stepId, info] of Object.entries(hops)) {
    lines.push(`Step: ${stepId}  (workspace: ${info.workspace ?? "(no workspace)"})`);
    if (info.entries.length === 0) { lines.push("  (no hops)"); continue; }
    info.entries.forEach((e, i) =>
      lines.push(`  ${i + 1}. ${e.ref}  →  ${e.outcome}  (match: ${e.match_kind ?? "none"})`));
  }
  return lines.join("\n");
}

export interface EmitHopsArgs {
  runId: string; state: RunState; aoCtx: AoContext; cwd: string;
  filterStep?: StepID; jsonMode: boolean;
  emitResult: (label: string, payload: Record<string, unknown>) => void;
}

export async function emitHopsForRun(args: EmitHopsArgs): Promise<void> {
  const hops = await collect(args.state, args.aoCtx, args.cwd, args.filterStep);
  const empty = Object.values(hops).every((i) => i.entries.length === 0);
  if (args.jsonMode) {
    args.emitResult("show-hops", { run_id: args.runId, hops_by_step: hops });
    return;
  }
  process.stdout.write(empty ? "No hop records found.\n" : `${format(hops)}\n`);
}
