// Detect and (optionally) auto-start the AO daemon for `aow run`. The daemon
// is identified by ~/.agent-orchestrator/running.json — written by `ao start`
// with its pid, port, and registered project list.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { WorkflowError } from "../errors.js";

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  port?: number;
  projects?: string[];
}

const DEFAULT_RUNNING_PATH = join(homedir(), ".agent-orchestrator", "running.json");
const POLL_INTERVAL_MS = 250;
const POLL_TIMEOUT_MS = 10_000;

function runningPath(): string {
  return process.env.AOW_DAEMON_RUNNING_PATH ?? DEFAULT_RUNNING_PATH;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

export async function getDaemonStatus(): Promise<DaemonStatus> {
  let text: string;
  try {
    text = await readFile(runningPath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { running: false };
    throw err;
  }
  let parsed: { pid?: number; port?: number; projects?: string[] };
  try {
    parsed = JSON.parse(text);
  } catch {
    return { running: false };
  }
  if (typeof parsed.pid !== "number" || !isAlive(parsed.pid)) return { running: false };
  return { running: true, pid: parsed.pid, port: parsed.port, projects: parsed.projects };
}

export async function ensureDaemonRunning(): Promise<boolean> {
  if ((await getDaemonStatus()).running) return true;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn("ao", ["start", "--no-dashboard"], { detached: true, stdio: "ignore" });
  } catch (err) {
    throw new WorkflowError(
      "WF_AO_CONTEXT",
      "AO daemon is not running and 'ao' CLI was not found. Run 'npm install -g @aoagents/ao' or start the daemon manually.",
      { cause: err },
    );
  }
  child.on("error", () => {
    // surfaced via the polling timeout below
  });
  child.unref();
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await getDaemonStatus()).running) return true;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new WorkflowError(
    "WF_AO_CONTEXT",
    "Attempted to auto-start AO daemon via 'ao start --no-dashboard' but it did not register within 10s. Start it manually and retry.",
  );
}
