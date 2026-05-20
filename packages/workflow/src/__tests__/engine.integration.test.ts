// End-to-end engine test against a stubbed AO context. We don't touch the real
// session manager — the AoContext factory returns a hand-rolled object whose
// sm.spawn/get/kill drive completion-detector. The "agent" is simulated by a
// timer that writes the expected output file shortly after spawn.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@aoagents/ao-core", () => ({
  loadConfig: vi.fn(),
  createPluginRegistry: vi.fn(),
  createSessionManager: vi.fn(),
  createLifecycleManager: vi.fn(),
}));

const { decideGate } = await import("../approvals.js");
const { runWorkflow } = await import("../engine.js");
const { loadRunState } = await import("../state-store.js");

interface FakeSession {
  id: string;
  status: string;
  activity: string | null;
  lastActivityAt: Date | null;
  branch: string | null;
}

interface MockController {
  spawn: ReturnType<typeof vi.fn>;
  sessions: Map<string, FakeSession>;
  /** Tweak how an "agent" behaves on spawn — return null to use defaults. */
  onSpawn?: (sessionId: string) => Promise<void> | void;
  killed: string[];
}

function buildAoCtx(controller: MockController) {
  return {
    sm: {
      spawn: controller.spawn,
      get: vi.fn(async (id: string) => {
        return controller.sessions.get(id) ?? null;
      }),
      kill: vi.fn(async (id: string) => {
        controller.killed.push(id);
        const s = controller.sessions.get(id);
        if (s) {
          s.status = "killed";
          s.activity = "exited";
        }
      }),
    },
    lm: {},
    config: {},
  } as unknown as Awaited<ReturnType<typeof import("../ao-client.js").createAoContext>>;
}

function makeController(opts: {
  outputAbsPath: () => string;
  outputContent?: string;
}): MockController {
  const controller: MockController = {
    spawn: vi.fn(),
    sessions: new Map(),
    killed: [],
  };
  let counter = 0;
  controller.spawn.mockImplementation(async (req: { branch: string }) => {
    counter += 1;
    const id = `ses-${counter}`;
    const session: FakeSession = {
      id,
      status: "active",
      activity: "active",
      lastActivityAt: new Date(),
      branch: req.branch,
    };
    controller.sessions.set(id, session);
    // Schedule the "agent" to write its output and go idle on the next tick.
    setTimeout(() => {
      // Write output file then transition to idle so the engine picks it up.
      void (async () => {
        const abs = opts.outputAbsPath();
        await mkdir(join(abs, ".."), { recursive: true }).catch(() => undefined);
        await writeFile(abs, opts.outputContent ?? `output from ${id}`, "utf8");
        session.activity = "idle";
        session.status = "idle";
        session.lastActivityAt = new Date();
      })();
    }, 20);
    return { id, branch: req.branch };
  });
  return controller;
}

interface SetupResult {
  dir: string;
  workflowPath: string;
  artifactsDir: string;
  outputPath: () => string;
}

async function setupWorkspace(workflowYaml: string): Promise<SetupResult> {
  const dir = await mkdtemp(join(tmpdir(), "aow-engine-"));
  const workflowPath = join(dir, "workflow.yaml");
  await writeFile(workflowPath, workflowYaml, "utf8");
  await writeFile(join(dir, "feature.md"), "demo feature\n", "utf8");
  const artifactsDir = join(dir, "workflow-artifacts");
  await mkdir(artifactsDir, { recursive: true });
  return {
    dir,
    workflowPath,
    artifactsDir,
    outputPath: () => join(artifactsDir, "hello.md"),
  };
}

const HELLO_YAML = `id: hello-world
description: integration test fixture
artifacts_dir: ./workflow-artifacts
project_id: test-project

inputs:
  - name: feature
    path: ./feature.md

steps:
  - id: write_hello
    type: agent
    agent: claude-code
    prompt: |
      Read {{inputs.feature}}; write hello to {{outputs.hello}}.
    outputs:
      hello: hello.md

  - id: hello_review
    type: human_approval
    depends_on: [write_hello]
    message: review hello.md
    on_reject: write_hello
    max_revisions: 3
`;

let workspaces: string[] = [];

beforeEach(() => {
  workspaces = [];
});

afterEach(async () => {
  for (const dir of workspaces) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function freshWorkspace(): Promise<SetupResult> {
  const ws = await setupWorkspace(HELLO_YAML);
  workspaces.push(ws.dir);
  return ws;
}

describe("runWorkflow integration", () => {
  it("runs an agent step then enters the approval gate, then completes on approve", async () => {
    const ws = await freshWorkspace();
    const controller = makeController({ outputAbsPath: ws.outputPath });

    // Detach so the test can call decideGate then re-enter runWorkflow.
    const first = await runWorkflow({
      workflowPath: ws.workflowPath,
      selector: { kind: "all" },
      detach: true,
      aoContextFactory: async () => buildAoCtx(controller),
      completionPollIntervalMs: 5,
      completionIdleThresholdMs: 10,
    });

    expect(first.status).toBe("awaiting_approval");
    expect(first.awaitingApprovals).toEqual(["hello_review"]);
    expect(first.steps.write_hello).toBe("completed");
    expect(controller.spawn).toHaveBeenCalledTimes(1);

    // Output file present and non-empty.
    const written = await readFile(ws.outputPath(), "utf8");
    expect(written).toContain("output from ses-1");

    await decideGate(first.runDir, "hello_review", { kind: "approve" });

    const second = await runWorkflow({
      workflowPath: ws.workflowPath,
      runId: first.runId,
      selector: { kind: "all" },
      detach: true,
      aoContextFactory: async () => buildAoCtx(controller),
      completionPollIntervalMs: 5,
      completionIdleThresholdMs: 10,
    });

    expect(second.status).toBe("completed");
    expect(second.steps.hello_review).toBe("completed");
    expect(second.awaitingApprovals).toEqual([]);
  });

  it("loops back to the agent step on rejection with feedback in the next prompt", async () => {
    const ws = await freshWorkspace();
    const controller = makeController({ outputAbsPath: ws.outputPath });

    const first = await runWorkflow({
      workflowPath: ws.workflowPath,
      selector: { kind: "all" },
      detach: true,
      aoContextFactory: async () => buildAoCtx(controller),
      completionPollIntervalMs: 5,
      completionIdleThresholdMs: 10,
    });
    expect(first.status).toBe("awaiting_approval");

    await decideGate(first.runDir, "hello_review", {
      kind: "reject",
      feedback: "please make it more exciting",
      onRejectTarget: "write_hello",
    });

    // After rejection: write_hello reset to pending, hello_review also pending.
    const afterReject = await loadRunState(first.runDir);
    expect(afterReject.steps.write_hello.status).toBe("pending");
    expect(afterReject.steps.hello_review.status).toBe("pending");

    const second = await runWorkflow({
      workflowPath: ws.workflowPath,
      runId: first.runId,
      selector: { kind: "all" },
      detach: true,
      aoContextFactory: async () => buildAoCtx(controller),
      completionPollIntervalMs: 5,
      completionIdleThresholdMs: 10,
    });

    expect(second.status).toBe("awaiting_approval");
    expect(controller.spawn).toHaveBeenCalledTimes(2);
    // Second spawn's prompt should include the feedback preamble.
    const secondCall = controller.spawn.mock.calls[1][0] as { prompt: string };
    expect(secondCall.prompt).toContain("PRIOR ATTEMPT FEEDBACK");
    expect(secondCall.prompt).toContain("please make it more exciting");

    await decideGate(second.runDir, "hello_review", { kind: "approve" });

    const third = await runWorkflow({
      workflowPath: ws.workflowPath,
      runId: first.runId,
      selector: { kind: "all" },
      detach: true,
      aoContextFactory: async () => buildAoCtx(controller),
      completionPollIntervalMs: 5,
      completionIdleThresholdMs: 10,
    });
    expect(third.status).toBe("completed");
  });

  it("resumes a partially-completed run using the same run id", async () => {
    const ws = await freshWorkspace();
    const controller = makeController({ outputAbsPath: ws.outputPath });

    const first = await runWorkflow({
      workflowPath: ws.workflowPath,
      selector: { kind: "all" },
      detach: true,
      aoContextFactory: async () => buildAoCtx(controller),
      completionPollIntervalMs: 5,
      completionIdleThresholdMs: 10,
    });
    expect(first.status).toBe("awaiting_approval");

    // Simulate a crash: drop the controller; build a fresh one for the resume.
    const controller2 = makeController({ outputAbsPath: ws.outputPath });

    // Approving via decideGate from a new process happens out-of-band — emulate
    // that by calling it before resume.
    await decideGate(first.runDir, "hello_review", { kind: "approve" });

    const resumed = await runWorkflow({
      workflowPath: ws.workflowPath,
      runId: first.runId,
      selector: { kind: "all" },
      detach: true,
      aoContextFactory: async () => buildAoCtx(controller2),
      completionPollIntervalMs: 5,
      completionIdleThresholdMs: 10,
    });

    expect(resumed.runId).toBe(first.runId);
    expect(resumed.status).toBe("completed");
    // No new agent spawn during resume because write_hello was already done.
    expect(controller2.spawn).not.toHaveBeenCalled();
  });
});
