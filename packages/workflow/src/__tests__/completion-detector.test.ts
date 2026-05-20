import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ArtifactRef } from "../types.js";

// Mock @aoagents/ao-core so importing ao-client doesn't drag in the real
// session manager. completion-detector goes through ao-client.getSessionStatus
// which we shim below.
vi.mock("@aoagents/ao-core", () => ({
  loadConfig: vi.fn(),
  createPluginRegistry: vi.fn(),
  createSessionManager: vi.fn(),
  createLifecycleManager: vi.fn(),
}));

const getSessionStatus = vi.fn();
vi.mock("../ao-client.js", async () => {
  const actual = await vi.importActual<typeof import("../ao-client.js")>("../ao-client.js");
  return {
    ...actual,
    getSessionStatus,
  };
});

const fsAccess = vi.fn();
const fsReadFile = vi.fn();
vi.mock("node:fs/promises", () => ({
  access: fsAccess,
  readFile: fsReadFile,
}));

const { waitForStepCompletion } = await import("../completion-detector.js");

type Snapshot = {
  status: string;
  activity: string | null;
  lastActivityAt: string | null;
};

function snapshot(status: string, activity: string | null): Snapshot {
  return { status, activity, lastActivityAt: null };
}

function existsMap(present: Set<string>): (path: string) => Promise<void> {
  return async (path: string) => {
    if (!present.has(path)) {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
  };
}

const OUTPUTS: ArtifactRef[] = [
  { name: "design", path: "design.md" },
  { name: "notes", path: "notes.md" },
];
const ARTIFACTS_DIR = "/artifacts";
const DESIGN_ABS = "/artifacts/design.md";
const NOTES_ABS = "/artifacts/notes.md";

const fakeCtx = { sm: {}, lm: {}, config: {} } as unknown as Parameters<
  typeof waitForStepCompletion
>[0]["ctx"];

beforeEach(() => {
  getSessionStatus.mockReset();
  fsAccess.mockReset();
  fsReadFile.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("waitForStepCompletion", () => {
  it("returns 'completed' once outputs exist AND activity has been idle for ≥ threshold", async () => {
    const present = new Set([DESIGN_ABS, NOTES_ABS]);
    fsAccess.mockImplementation(existsMap(present));
    fsReadFile.mockImplementation(async (path: string) => Buffer.from(`contents-of-${path}`));
    getSessionStatus.mockResolvedValue(snapshot("working", "idle"));

    const pending = waitForStepCompletion({
      ctx: fakeCtx,
      sessionId: "ses-1",
      expectedOutputs: OUTPUTS,
      artifactsDir: ARTIFACTS_DIR,
      timeoutMs: 60_000,
      idleThresholdMs: 1_000,
      pollIntervalMs: 100,
    });

    // Drain three poll ticks so idleSince has had 200ms+ wall-clock to elapse.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1_000);

    const result = await pending;
    expect(result.kind).toBe("completed");
    if (result.kind === "completed") {
      expect(result.outputs).toHaveLength(2);
      expect(result.outputs[0]).toMatchObject({ name: "design", path: DESIGN_ABS });
      expect(result.outputs[0].hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("returns 'timeout' when wall-clock exceeds timeoutMs before outputs appear", async () => {
    fsAccess.mockImplementation(existsMap(new Set()));
    getSessionStatus.mockResolvedValue(snapshot("working", "active"));

    const pending = waitForStepCompletion({
      ctx: fakeCtx,
      sessionId: "ses-1",
      expectedOutputs: OUTPUTS,
      artifactsDir: ARTIFACTS_DIR,
      timeoutMs: 250,
      idleThresholdMs: 100,
      pollIntervalMs: 100,
    });

    await vi.advanceTimersByTimeAsync(1_000);

    const result = await pending;
    expect(result.kind).toBe("timeout");
    if (result.kind === "timeout") {
      expect(result.reason).toContain("not produced");
    }
  });

  it("returns 'failed' when the session reaches a terminal status with outputs missing", async () => {
    fsAccess.mockImplementation(existsMap(new Set()));
    getSessionStatus.mockResolvedValue(snapshot("terminated", "exited"));

    const pending = waitForStepCompletion({
      ctx: fakeCtx,
      sessionId: "ses-1",
      expectedOutputs: OUTPUTS,
      artifactsDir: ARTIFACTS_DIR,
      timeoutMs: 60_000,
      idleThresholdMs: 1_000,
      pollIntervalMs: 100,
    });

    await vi.advanceTimersByTimeAsync(0);

    const result = await pending;
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toContain("terminated");
    }
  });

  it("does NOT complete early when outputs exist but activity has been idle < threshold (waits)", async () => {
    fsAccess.mockImplementation(existsMap(new Set([DESIGN_ABS, NOTES_ABS])));
    fsReadFile.mockImplementation(async () => Buffer.from("x"));
    getSessionStatus.mockResolvedValue(snapshot("working", "idle"));

    const pending = waitForStepCompletion({
      ctx: fakeCtx,
      sessionId: "ses-1",
      expectedOutputs: OUTPUTS,
      artifactsDir: ARTIFACTS_DIR,
      timeoutMs: 60_000,
      idleThresholdMs: 5_000,
      pollIntervalMs: 100,
    });

    // Only 200ms of wall-clock elapses — well below the 5s idleThresholdMs.
    await vi.advanceTimersByTimeAsync(200);
    let resolved = false;
    void pending.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Now push wall-clock past the threshold so the next tick can settle.
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await pending;
    expect(result.kind).toBe("completed");
  });

  it("polls at the configured interval (count getSessionStatus calls)", async () => {
    fsAccess.mockImplementation(existsMap(new Set()));
    getSessionStatus.mockResolvedValue(snapshot("working", "active"));

    const pending = waitForStepCompletion({
      ctx: fakeCtx,
      sessionId: "ses-1",
      expectedOutputs: OUTPUTS,
      artifactsDir: ARTIFACTS_DIR,
      timeoutMs: 350,
      pollIntervalMs: 100,
    });

    await vi.advanceTimersByTimeAsync(800);
    const result = await pending;

    // The first poll runs at t=0 (no sleep yet); subsequent polls happen
    // after each pollIntervalMs sleep. With timeoutMs=350 and pollIntervalMs
    // =100, we expect ~4–5 polls (ticks at t=0,100,200,300,400 — the loop
    // breaks when wall-clock crosses timeoutMs).
    expect(result.kind).toBe("timeout");
    expect(getSessionStatus.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(getSessionStatus.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("resolves output hashes correctly on success (sha256 of file contents)", async () => {
    const { createHash } = await import("node:crypto");
    fsAccess.mockImplementation(existsMap(new Set([DESIGN_ABS, NOTES_ABS])));
    fsReadFile.mockImplementation(async (path: string) =>
      Buffer.from(path === DESIGN_ABS ? "DESIGN-BODY" : "NOTES-BODY"),
    );
    getSessionStatus.mockResolvedValue(snapshot("working", "ready"));

    const pending = waitForStepCompletion({
      ctx: fakeCtx,
      sessionId: "ses-1",
      expectedOutputs: OUTPUTS,
      artifactsDir: ARTIFACTS_DIR,
      timeoutMs: 60_000,
      idleThresholdMs: 0,
      pollIntervalMs: 100,
    });

    await vi.advanceTimersByTimeAsync(50);
    const result = await pending;

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    const designHash = createHash("sha256").update(Buffer.from("DESIGN-BODY")).digest("hex");
    const notesHash = createHash("sha256").update(Buffer.from("NOTES-BODY")).digest("hex");
    expect(result.outputs[0].hash).toBe(designHash);
    expect(result.outputs[1].hash).toBe(notesHash);
  });

  it("resets the idle counter when activity moves back to 'active' before threshold (does not complete prematurely)", async () => {
    fsAccess.mockImplementation(existsMap(new Set([DESIGN_ABS, NOTES_ABS])));
    fsReadFile.mockImplementation(async () => Buffer.from("x"));
    // First few polls: idle; then active; then idle again.
    getSessionStatus
      .mockResolvedValueOnce(snapshot("working", "idle"))
      .mockResolvedValueOnce(snapshot("working", "idle"))
      .mockResolvedValueOnce(snapshot("working", "active"))
      .mockResolvedValue(snapshot("working", "idle"));

    const pending = waitForStepCompletion({
      ctx: fakeCtx,
      sessionId: "ses-1",
      expectedOutputs: OUTPUTS,
      artifactsDir: ARTIFACTS_DIR,
      timeoutMs: 60_000,
      idleThresholdMs: 500,
      pollIntervalMs: 100,
    });

    await vi.advanceTimersByTimeAsync(2_000);

    const result = await pending;
    expect(result.kind).toBe("completed");
  });
});
