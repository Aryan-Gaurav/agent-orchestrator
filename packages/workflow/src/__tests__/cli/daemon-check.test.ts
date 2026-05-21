import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDaemonRunning, getDaemonStatus } from "../../cli/daemon-check.js";

let dir: string;
let runningPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aow-daemon-"));
  runningPath = join(dir, "running.json");
  process.env.AOW_DAEMON_RUNNING_PATH = runningPath;
});

afterEach(async () => {
  delete process.env.AOW_DAEMON_RUNNING_PATH;
  await rm(dir, { recursive: true, force: true });
});

describe("getDaemonStatus", () => {
  it("returns running=false when running.json is missing", async () => {
    const status = await getDaemonStatus();
    expect(status.running).toBe(false);
  });

  it("returns running=false when pid is stale", async () => {
    const deadPid = 2_147_483_640;
    await writeFile(runningPath, JSON.stringify({ pid: deadPid, port: 4000, projects: [] }));
    const status = await getDaemonStatus();
    expect(status.running).toBe(false);
  });

  it("returns running=true when pid is alive", async () => {
    await writeFile(
      runningPath,
      JSON.stringify({ pid: process.pid, port: 4321, projects: ["x"] }),
    );
    const status = await getDaemonStatus();
    expect(status.running).toBe(true);
    expect(status.pid).toBe(process.pid);
    expect(status.port).toBe(4321);
    expect(status.projects).toEqual(["x"]);
  });
});

describe("ensureDaemonRunning", () => {
  it("returns true without spawning when daemon already running", async () => {
    await writeFile(runningPath, JSON.stringify({ pid: process.pid, port: 9000 }));
    const start = Date.now();
    const ok = await ensureDaemonRunning();
    const elapsed = Date.now() - start;
    expect(ok).toBe(true);
    // Must short-circuit on already-running; no spawn, no polling delay.
    expect(elapsed).toBeLessThan(200);
  });
});
