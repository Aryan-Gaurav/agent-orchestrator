// Integration tests for Phase 3.8 engine fixes:
//   Fix 3 — citations_invalid triggers revision loop (capped by max_revisions)
//   Fix 4 — LintReport persists into state.json
//   Fix 5 — branch name includes run_id (cross-run cleanup) + aow clean

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

const { runWorkflow } = await import("../../engine.js");
const { loadRunState } = await import("../../state-store.js");
const { cleanCmd } = await import("../../cli.js");

interface FakeSession {
  id: string;
  status: string;
  activity: string | null;
  lastActivityAt: Date | null;
  branch: string | null;
  workspacePath: string;
}

const sessionWorkspaces: string[] = [];
let workspaces: string[] = [];

beforeEach(() => { workspaces = []; });

afterEach(async () => {
  for (const d of workspaces) await rm(d, { recursive: true, force: true }).catch(() => undefined);
  while (sessionWorkspaces.length) {
    const d = sessionWorkspaces.pop();
    if (d) await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
});

function buildAoCtx(
  sessions: Map<string, FakeSession>,
  spawn: ReturnType<typeof vi.fn>,
  extra?: { list?: ReturnType<typeof vi.fn>; kill?: ReturnType<typeof vi.fn> },
) {
  return {
    sm: {
      spawn,
      get: vi.fn(async (id: string) => sessions.get(id) ?? null),
      kill: extra?.kill ?? vi.fn(async (id: string) => {
        const s = sessions.get(id);
        if (s) { s.status = "killed"; s.activity = "exited"; }
      }),
      list: extra?.list ?? vi.fn(async () =>
        Array.from(sessions.values()).filter((s) => s.status !== "killed"),
      ),
    },
    lm: {}, config: {}, projectId: "test-project",
  } as unknown as Awaited<ReturnType<typeof import("../../ao-client.js").createAoContext>>;
}

type ScriptFn = (workspacePath: string, artifactsDir: string) => Promise<void>;

function makeSpawner(
  scripts: ScriptFn[],
  artifactsDir: string,
  sessions: Map<string, FakeSession>,
) {
  const spawn = vi.fn();
  let n = 0;
  spawn.mockImplementation(async (req: { branch: string }) => {
    n += 1;
    const id = `ses-${n}`;
    const workspacePath = await mkdtemp(join(tmpdir(), "aow-3-8-ws-"));
    sessionWorkspaces.push(workspacePath);
    const sess: FakeSession = {
      id, status: "active", activity: "active",
      lastActivityAt: new Date(), branch: req.branch, workspacePath,
    };
    sessions.set(id, sess);
    const script = scripts[n - 1];
    setTimeout(() => {
      void (async () => {
        if (script) await script(workspacePath, artifactsDir);
        sess.activity = "idle"; sess.status = "idle"; sess.lastActivityAt = new Date();
      })();
    }, 20);
    return { id, branch: req.branch };
  });
  return spawn;
}

const DESIGN = `# Design\n\n## Section A\nAlpha section body explains the alpha feature.\n`;

const IMPL_BAD = `# Impl\n\n<!-- ref: design.md#missing-section claim="alpha" -->\n`;
const IMPL_GOOD = `# Impl\n\n<!-- ref: design.md#section-a claim="alpha feature" -->\n`;

async function setupWorkspace(yaml: string): Promise<{ dir: string; workflowPath: string; artifactsDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "aow-3-8-"));
  workspaces.push(dir);
  const workflowPath = join(dir, "workflow.yaml");
  await writeFile(workflowPath, yaml, "utf8");
  const artifactsDir = join(dir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  return { dir, workflowPath, artifactsDir };
}

const YAML_DEFAULT_MAX = `id: rev-default
artifacts_dir: ./artifacts
project_id: test-project
steps:
  - id: design
    type: agent
    agent: claude-code
    prompt: write to {{outputs.design}}
    outputs:
      design: design.md
  - id: impl
    type: agent
    agent: claude-code
    depends_on: [design]
    inputs:
      design: design.md
    prompt: implement per {{inputs.design}} into {{outputs.impl}}
    outputs:
      impl: impl.md
`;

const YAML_FAST_TIMEOUT = `id: rev-fast-timeout
artifacts_dir: ./artifacts
project_id: test-project
steps:
  - id: design
    type: agent
    agent: claude-code
    prompt: write to {{outputs.design}}
    timeout_minutes: 0.005
    outputs:
      design: design.md
`;

const YAML_MAX_1 = `id: rev-cap-1
artifacts_dir: ./artifacts
project_id: test-project
steps:
  - id: design
    type: agent
    agent: claude-code
    prompt: write to {{outputs.design}}
    outputs:
      design: design.md
  - id: impl
    type: agent
    agent: claude-code
    depends_on: [design]
    inputs:
      design: design.md
    prompt: implement per {{inputs.design}} into {{outputs.impl}}
    outputs:
      impl: impl.md
    max_revisions: 1
`;

describe("Phase 3.8 — Fix 3: citations_invalid triggers revision loop", () => {
  it("fails lint once, retries with feedback, passes on attempt 2", async () => {
    const ws = await setupWorkspace(YAML_DEFAULT_MAX);
    const sessions = new Map<string, FakeSession>();
    const writeArt = (name: string, body: string): ScriptFn =>
      async (_w, dir) => { await writeFile(join(dir, name), body, "utf8"); };
    const spawn = makeSpawner(
      [writeArt("design.md", DESIGN), writeArt("impl.md", IMPL_BAD), writeArt("impl.md", IMPL_GOOD)],
      ws.artifactsDir, sessions,
    );

    const result = await runWorkflow({
      workflowPath: ws.workflowPath,
      selector: { kind: "all" }, detach: true,
      aoContextFactory: async () => buildAoCtx(sessions, spawn),
      completionPollIntervalMs: 5, completionIdleThresholdMs: 10,
    });

    expect(result.status).toBe("completed");
    const state = await loadRunState(result.runDir);
    expect(state.steps.impl.status).toBe("completed");
    expect(state.steps.impl.attempts).toBe(2);
    expect(spawn).toHaveBeenCalledTimes(3); // design + impl x2
  });

  it("gives up after max_revisions and marks run failed (cap=1, two bad outputs)", async () => {
    const ws = await setupWorkspace(YAML_MAX_1);
    const sessions = new Map<string, FakeSession>();
    const writeArt = (name: string, body: string): ScriptFn =>
      async (_w, dir) => { await writeFile(join(dir, name), body, "utf8"); };
    const spawn = makeSpawner(
      [writeArt("design.md", DESIGN), writeArt("impl.md", IMPL_BAD)],
      ws.artifactsDir, sessions,
    );

    const result = await runWorkflow({
      workflowPath: ws.workflowPath,
      selector: { kind: "all" }, detach: true,
      aoContextFactory: async () => buildAoCtx(sessions, spawn),
      completionPollIntervalMs: 5, completionIdleThresholdMs: 10,
    });

    expect(result.status).toBe("failed");
    const state = await loadRunState(result.runDir);
    expect(state.steps.impl.status).toBe("failed");
    expect(state.steps.impl.failure_reason).toBe("citations_invalid");
    expect(state.steps.impl.attempts).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(2); // design + impl x1 (cap=1 → no retry)
  });

  it("non-citation failures still abort immediately (no revision)", async () => {
    const ws = await setupWorkspace(YAML_FAST_TIMEOUT);
    const sessions = new Map<string, FakeSession>();
    // Don't write the output → completion-detector times out (300ms cap).
    const spawn = makeSpawner([async () => undefined], ws.artifactsDir, sessions);

    const result = await runWorkflow({
      workflowPath: ws.workflowPath,
      selector: { kind: "all" }, detach: true,
      aoContextFactory: async () => buildAoCtx(sessions, spawn),
      completionPollIntervalMs: 50, completionIdleThresholdMs: 50,
    });

    expect(result.status).toBe("failed");
    expect(spawn).toHaveBeenCalledTimes(1); // no retry on timeout
  }, 15_000);
});

describe("Phase 3.8 — Fix 4: LintReport persists to state.json", () => {
  it("failed attempt's lint_report is preserved with errors and warnings", async () => {
    const ws = await setupWorkspace(YAML_MAX_1);
    const sessions = new Map<string, FakeSession>();
    const writeArt = (name: string, body: string): ScriptFn =>
      async (_w, dir) => { await writeFile(join(dir, name), body, "utf8"); };
    const spawn = makeSpawner(
      [writeArt("design.md", DESIGN), writeArt("impl.md", IMPL_BAD)],
      ws.artifactsDir, sessions,
    );

    const result = await runWorkflow({
      workflowPath: ws.workflowPath,
      selector: { kind: "all" }, detach: true,
      aoContextFactory: async () => buildAoCtx(sessions, spawn),
      completionPollIntervalMs: 5, completionIdleThresholdMs: 10,
    });

    expect(result.status).toBe("failed");
    const state = await loadRunState(result.runDir);
    const report = state.steps.impl.current_attempt?.lint_report;
    expect(report).toBeDefined();
    expect(report?.errors.length).toBeGreaterThan(0);
    expect(report?.errors[0].code).toBe("section_not_found");
    expect(report?.errors[0].outputFile).toBe("impl.md");
  });

  it("retried attempt with revision available stores prior lint_report in history", async () => {
    const ws = await setupWorkspace(YAML_DEFAULT_MAX);
    const sessions = new Map<string, FakeSession>();
    const writeArt = (name: string, body: string): ScriptFn =>
      async (_w, dir) => { await writeFile(join(dir, name), body, "utf8"); };
    const spawn = makeSpawner(
      [writeArt("design.md", DESIGN), writeArt("impl.md", IMPL_BAD), writeArt("impl.md", IMPL_GOOD)],
      ws.artifactsDir, sessions,
    );
    await runWorkflow({
      workflowPath: ws.workflowPath,
      selector: { kind: "all" }, detach: true,
      aoContextFactory: async () => buildAoCtx(sessions, spawn),
      completionPollIntervalMs: 5, completionIdleThresholdMs: 10,
    });
    const state = await loadRunState((await loadLatestRunDir(ws.dir)));
    const history = state.steps.impl.history ?? [];
    expect(history).toHaveLength(1);
    expect(history[0].lint_report?.errors.length).toBeGreaterThan(0);
  });
});

describe("Phase 3.8 — Fix 5: branch naming + aow clean", () => {
  it("branch name embeds run_id so two runs of the same workflow don't collide", async () => {
    const ws = await setupWorkspace(YAML_DEFAULT_MAX);
    const sessions1 = new Map<string, FakeSession>();
    const writeArt = (name: string, body: string): ScriptFn =>
      async (_w, dir) => { await writeFile(join(dir, name), body, "utf8"); };
    const spawn1 = makeSpawner(
      [writeArt("design.md", DESIGN), writeArt("impl.md", IMPL_GOOD)],
      ws.artifactsDir, sessions1,
    );
    const first = await runWorkflow({
      workflowPath: ws.workflowPath,
      selector: { kind: "all" }, detach: true,
      aoContextFactory: async () => buildAoCtx(sessions1, spawn1),
      completionPollIntervalMs: 5, completionIdleThresholdMs: 10,
    });
    expect(first.status).toBe("completed");

    // Wipe state to force a brand-new run with a different run_id timestamp.
    await rm(join(ws.dir, ".workflow-state"), { recursive: true, force: true });
    // Sleep just long enough so the run_id timestamp differs.
    await new Promise((r) => setTimeout(r, 1100));

    const sessions2 = new Map<string, FakeSession>();
    const spawn2 = makeSpawner(
      [writeArt("design.md", DESIGN), writeArt("impl.md", IMPL_GOOD)],
      ws.artifactsDir, sessions2,
    );
    const second = await runWorkflow({
      workflowPath: ws.workflowPath,
      selector: { kind: "all" }, detach: true,
      aoContextFactory: async () => buildAoCtx(sessions2, spawn2),
      completionPollIntervalMs: 5, completionIdleThresholdMs: 10,
    });
    expect(second.status).toBe("completed");
    expect(second.runId).not.toBe(first.runId);

    const firstBranch = spawn1.mock.calls[0][0].branch as string;
    const secondBranch = spawn2.mock.calls[0][0].branch as string;
    expect(firstBranch).toContain(first.runId);
    expect(secondBranch).toContain(second.runId);
    expect(firstBranch).not.toBe(secondBranch);
  });

  it("aow clean <run-id> kills only sessions for that run", async () => {
    const ws = await setupWorkspace(YAML_DEFAULT_MAX);
    const sessions = new Map<string, FakeSession>();
    // Pre-populate with sessions: two from a "stale" run, one unrelated.
    sessions.set("s-stale-1", {
      id: "s-stale-1", status: "active", activity: "active",
      lastActivityAt: new Date(), workspacePath: "/tmp",
      branch: "aow-rev-default-design-1-wf-rev-default-OLDTIME",
    });
    sessions.set("s-stale-2", {
      id: "s-stale-2", status: "active", activity: "active",
      lastActivityAt: new Date(), workspacePath: "/tmp",
      branch: "aow-rev-default-impl-1-wf-rev-default-OLDTIME",
    });
    sessions.set("s-other", {
      id: "s-other", status: "active", activity: "active",
      lastActivityAt: new Date(), workspacePath: "/tmp",
      branch: "feature/unrelated",
    });

    const killed: string[] = [];
    const killSpy = vi.fn(async (id: string) => {
      killed.push(id);
      const s = sessions.get(id);
      if (s) s.status = "killed";
    });

    const ctx = buildAoCtx(sessions, vi.fn(), { kill: killSpy });
    await cleanCmd("wf-rev-default-OLDTIME", {
      workflowFile: ws.workflowPath,
      aoContextFactory: async () => ctx,
    });

    expect(killed.sort()).toEqual(["s-stale-1", "s-stale-2"]);
  });

  it("aow clean --all kills every session for this workflow regardless of run", async () => {
    const ws = await setupWorkspace(YAML_DEFAULT_MAX);
    const sessions = new Map<string, FakeSession>();
    sessions.set("s-a", {
      id: "s-a", status: "active", activity: "active",
      lastActivityAt: new Date(), workspacePath: "/tmp",
      branch: "aow-rev-default-design-1-wf-rev-default-T1",
    });
    sessions.set("s-b", {
      id: "s-b", status: "active", activity: "active",
      lastActivityAt: new Date(), workspacePath: "/tmp",
      branch: "aow-rev-default-design-1-wf-rev-default-T2",
    });
    sessions.set("s-other-wf", {
      id: "s-other-wf", status: "active", activity: "active",
      lastActivityAt: new Date(), workspacePath: "/tmp",
      branch: "aow-other-workflow-design-1-wf-other-workflow-T1",
    });

    const killed: string[] = [];
    const killSpy = vi.fn(async (id: string) => { killed.push(id); });
    const ctx = buildAoCtx(sessions, vi.fn(), { kill: killSpy });

    await cleanCmd(undefined, { all: true, workflowFile: ws.workflowPath, aoContextFactory: async () => ctx });

    expect(killed.sort()).toEqual(["s-a", "s-b"]);
  });

  it("aow clean refuses when neither run-id nor --all is given", async () => {
    const ws = await setupWorkspace(YAML_DEFAULT_MAX);
    const sessions = new Map<string, FakeSession>();
    const ctx = buildAoCtx(sessions, vi.fn());
    await expect(
      cleanCmd(undefined, { workflowFile: ws.workflowPath, aoContextFactory: async () => ctx }),
    ).rejects.toThrow(/run-id.*--all/);
  });
});

async function loadLatestRunDir(projectDir: string): Promise<string> {
  const { readdir } = await import("node:fs/promises");
  const base = join(projectDir, ".workflow-state", "runs");
  const entries = await readdir(base);
  const dirs = entries.filter((e) => e.startsWith("wf-")).sort();
  return join(base, dirs[dirs.length - 1]);
}
