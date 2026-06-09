// Integration tests for Phase 4a.1 (Finding 10):
// End-of-run sweep that kills AO sessions belonging to the just-finished run.
//
// Covers:
//   - shouldSweepAfterRun decision matrix (status + flags).
//   - maybeSweepRunSessions actually kills sessions whose branch ends with
//     `-<run-id>`, and respects --keep-sessions / --detach.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@aoagents/ao-core", () => ({
  loadConfig: vi.fn(),
  createPluginRegistry: vi.fn(),
  createSessionManager: vi.fn(),
  createLifecycleManager: vi.fn(),
}));

const { shouldSweepAfterRun, maybeSweepRunSessions } = await import("../../cli.js");

interface FakeSession {
  id: string;
  status: string;
  activity: string | null;
  lastActivityAt: Date | null;
  branch: string | null;
  workspacePath: string;
}

const WORKFLOW_YAML = `id: sweep-test
artifacts_dir: ./artifacts
project_id: test-project
steps:
  - id: only
    type: agent
    agent: claude-code
    outputs:
      out: out.md
    prompt: "noop"
`;

let workspaces: string[] = [];

beforeEach(() => { workspaces = []; });

afterEach(async () => {
  for (const d of workspaces) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

async function setupWorkflowFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aow-4a-1-"));
  workspaces.push(dir);
  const path = join(dir, "workflow.yaml");
  await writeFile(path, WORKFLOW_YAML, "utf8");
  return path;
}

function buildAoCtx(
  sessions: Map<string, FakeSession>,
  killSpy: ReturnType<typeof vi.fn>,
) {
  return {
    sm: {
      spawn: vi.fn(),
      get: vi.fn(async (id: string) => sessions.get(id) ?? null),
      kill: killSpy,
      list: vi.fn(async () =>
        Array.from(sessions.values()).filter((s) => s.status !== "killed"),
      ),
    },
    lm: {}, config: {}, projectId: "test-project",
  } as unknown as Awaited<ReturnType<typeof import("../../ao-client.js").createAoContext>>;
}

describe("Phase 4a.1 — shouldSweepAfterRun decision matrix", () => {
  it("sweeps on completed (default flags)", () => {
    expect(shouldSweepAfterRun({ detach: false, keepSessions: false }, "completed")).toBe(true);
  });

  it("sweeps on failed (default flags)", () => {
    expect(shouldSweepAfterRun({ detach: false, keepSessions: false }, "failed")).toBe(true);
  });

  it("does not sweep when keepSessions is set, regardless of terminal status", () => {
    expect(shouldSweepAfterRun({ detach: false, keepSessions: true }, "completed")).toBe(false);
    expect(shouldSweepAfterRun({ detach: false, keepSessions: true }, "failed")).toBe(false);
  });

  it("does not sweep for non-terminal statuses or under --detach", () => {
    expect(shouldSweepAfterRun({ detach: false, keepSessions: false }, "awaiting_approval")).toBe(false);
    expect(shouldSweepAfterRun({ detach: false, keepSessions: false }, "pending")).toBe(false);
    expect(shouldSweepAfterRun({ detach: true, keepSessions: false }, "awaiting_approval")).toBe(false);
    expect(shouldSweepAfterRun({ detach: true, keepSessions: false }, "completed")).toBe(false);
  });
});

describe("Phase 4a.1 — maybeSweepRunSessions end-of-run sweep", () => {
  it("kills sessions whose branch ends with -<run-id> when status is completed", async () => {
    const workflowPath = await setupWorkflowFile();
    const runId = "wf-sweep-test-RUN1";
    const sessions = new Map<string, FakeSession>();
    sessions.set("ses-1", {
      id: "ses-1", status: "active", activity: "active",
      lastActivityAt: new Date(), workspacePath: "/tmp",
      branch: `aow-sweep-test-only-1-${runId}`,
    });
    sessions.set("ses-other", {
      id: "ses-other", status: "active", activity: "active",
      lastActivityAt: new Date(), workspacePath: "/tmp",
      branch: "aow-sweep-test-only-1-wf-sweep-test-OTHERRUN",
    });
    const killSpy = vi.fn(async (id: string) => {
      const s = sessions.get(id);
      if (s) s.status = "killed";
    });
    const ctx = buildAoCtx(sessions, killSpy);

    const result = await maybeSweepRunSessions({
      runId,
      status: "completed",
      workflowPath,
      detach: false,
      keepSessions: false,
      aoContextFactory: async () => ctx,
    });

    expect(killSpy).toHaveBeenCalledWith("ses-1", { reason: "auto_cleanup" });
    expect(killSpy).not.toHaveBeenCalledWith("ses-other", expect.anything());
    expect(result.killed).toEqual(["ses-1"]);
    expect(sessions.get("ses-1")?.status).toBe("killed");
  });

  it("does nothing when --keep-sessions is passed, even on completed", async () => {
    const workflowPath = await setupWorkflowFile();
    const runId = "wf-sweep-test-RUN2";
    const sessions = new Map<string, FakeSession>();
    sessions.set("ses-1", {
      id: "ses-1", status: "active", activity: "active",
      lastActivityAt: new Date(), workspacePath: "/tmp",
      branch: `aow-sweep-test-only-1-${runId}`,
    });
    const killSpy = vi.fn();
    const ctx = buildAoCtx(sessions, killSpy);

    const result = await maybeSweepRunSessions({
      runId,
      status: "completed",
      workflowPath,
      detach: false,
      keepSessions: true,
      aoContextFactory: async () => ctx,
    });

    expect(killSpy).not.toHaveBeenCalled();
    expect(result.killed).toEqual([]);
    expect(sessions.get("ses-1")?.status).toBe("active");
  });
});
