// Integration tests for Phase 3.9 Fix 3: revision loop kills the prior
// failed-attempt session (no more zombies).

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  killSpy: ReturnType<typeof vi.fn>,
) {
  return {
    sm: {
      spawn,
      get: vi.fn(async (id: string) => sessions.get(id) ?? null),
      kill: killSpy,
      list: vi.fn(async () =>
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
    const workspacePath = await mkdtemp(join(tmpdir(), "aow-3-9-ws-"));
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

const YAML_DEFAULT_MAX = `id: rev-default-39
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

async function setupWorkspace(yaml: string): Promise<{ dir: string; workflowPath: string; artifactsDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "aow-3-9-"));
  workspaces.push(dir);
  const workflowPath = join(dir, "workflow.yaml");
  await writeFile(workflowPath, yaml, "utf8");
  const artifactsDir = join(dir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  return { dir, workflowPath, artifactsDir };
}

const writeArt = (name: string, body: string): ScriptFn =>
  async (_w, dir) => { await writeFile(join(dir, name), body, "utf8"); };

describe("Phase 3.9 — Fix 3: revision loop kills prior session", () => {
  it("kills the failed attempt's session with reason 'auto_cleanup' before spawning the next attempt", async () => {
    const ws = await setupWorkspace(YAML_DEFAULT_MAX);
    const sessions = new Map<string, FakeSession>();
    const killSpy = vi.fn(async (id: string) => {
      const s = sessions.get(id);
      if (s) { s.status = "killed"; s.activity = "exited"; }
    });
    const spawn = makeSpawner(
      [writeArt("design.md", DESIGN), writeArt("impl.md", IMPL_BAD), writeArt("impl.md", IMPL_GOOD)],
      ws.artifactsDir, sessions,
    );

    const result = await runWorkflow({
      workflowPath: ws.workflowPath,
      selector: { kind: "all" }, detach: true,
      aoContextFactory: async () => buildAoCtx(sessions, spawn, killSpy),
      completionPollIntervalMs: 5, completionIdleThresholdMs: 10,
    });

    expect(result.status).toBe("completed");
    // Three spawns total: design + impl×2. The impl attempt-1 session must
    // have been killed once with reason auto_cleanup before attempt-2 spawn.
    expect(spawn).toHaveBeenCalledTimes(3);
    const implAttempt1SessionId = "ses-2"; // design=ses-1, impl#1=ses-2
    const implAttempt2SessionId = "ses-3";
    const killArgs = killSpy.mock.calls.map((c) => ({ id: c[0], reason: c[1]?.reason }));
    expect(killArgs).toContainEqual({ id: implAttempt1SessionId, reason: "auto_cleanup" });
    // The new attempt spawns a different session id.
    expect(spawn.mock.calls[2][0].branch).toMatch(/impl-2/);
    expect(sessions.has(implAttempt2SessionId)).toBe(true);
  });

  it("kill failure is non-fatal — revision still proceeds and the run completes", async () => {
    const ws = await setupWorkspace(YAML_DEFAULT_MAX);
    const sessions = new Map<string, FakeSession>();
    const killSpy = vi.fn(async () => {
      throw new Error("simulated kill failure");
    });
    const spawn = makeSpawner(
      [writeArt("design.md", DESIGN), writeArt("impl.md", IMPL_BAD), writeArt("impl.md", IMPL_GOOD)],
      ws.artifactsDir, sessions,
    );

    const result = await runWorkflow({
      workflowPath: ws.workflowPath,
      selector: { kind: "all" }, detach: true,
      aoContextFactory: async () => buildAoCtx(sessions, spawn, killSpy),
      completionPollIntervalMs: 5, completionIdleThresholdMs: 10,
    });

    expect(result.status).toBe("completed");
    expect(spawn).toHaveBeenCalledTimes(3);
    // Kill was attempted at least once for the impl attempt-1 session.
    expect(killSpy).toHaveBeenCalled();
  });
});
