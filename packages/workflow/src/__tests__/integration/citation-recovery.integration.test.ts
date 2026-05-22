// Real-AO integration test for Phase 3.5: drive the engine end-to-end through
// a citation failure + recovery, then exercise `aow show --hops` against the
// resulting run. Like engine.integration.test.ts, the AO context is mocked so
// no real Claude session is spawned, but the resolver script runs as a real
// subprocess and `.ao/ref-hops.jsonl` is written by the real linter pipeline.

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
const { showCmd } = await import("../../cli.js");

interface FakeSession {
  id: string;
  status: string;
  activity: string | null;
  lastActivityAt: Date | null;
  branch: string | null;
  workspacePath: string;
}

interface AgentScript {
  /** Called per spawn (in order) — writes the agent's "output" files. */
  produce: (workspacePath: string, artifactsDir: string) => Promise<void>;
}

const sessionWorkspaces: string[] = [];
let workspaces: string[] = [];

beforeEach(() => {
  workspaces = [];
});

afterEach(async () => {
  for (const d of workspaces) await rm(d, { recursive: true, force: true }).catch(() => undefined);
  while (sessionWorkspaces.length) {
    const d = sessionWorkspaces.pop();
    if (d) await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
});

function buildAoCtx(sessions: Map<string, FakeSession>, spawn: ReturnType<typeof vi.fn>) {
  return {
    sm: {
      spawn,
      get: vi.fn(async (id: string) => sessions.get(id) ?? null),
      kill: vi.fn(async (id: string) => {
        const s = sessions.get(id);
        if (s) { s.status = "killed"; s.activity = "exited"; }
      }),
    },
    lm: {}, config: {},
  } as unknown as Awaited<ReturnType<typeof import("../../ao-client.js").createAoContext>>;
}

function makeSpawner(scripts: AgentScript[], artifactsDir: string, sessions: Map<string, FakeSession>) {
  const spawn = vi.fn();
  let n = 0;
  spawn.mockImplementation(async (req: { branch: string }) => {
    n += 1;
    const id = `ses-${n}`;
    const workspacePath = await mkdtemp(join(tmpdir(), "aow-cit-ws-"));
    sessionWorkspaces.push(workspacePath);
    const sess: FakeSession = {
      id, status: "active", activity: "active",
      lastActivityAt: new Date(), branch: req.branch, workspacePath,
    };
    sessions.set(id, sess);
    const script = scripts[n - 1];
    setTimeout(() => {
      void (async () => {
        if (script) await script.produce(workspacePath, artifactsDir);
        sess.activity = "idle"; sess.status = "idle"; sess.lastActivityAt = new Date();
      })();
    }, 20);
    return { id, branch: req.branch };
  });
  return spawn;
}

const YAML = `id: citation-recovery
description: phase 3.5 integration fixture
artifacts_dir: ./artifacts
project_id: test-project

steps:
  - id: design
    type: agent
    agent: claude-code
    prompt: write design to {{outputs.design}}
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

const DESIGN_CONTENT = `# Design

## Section A
Alpha section body that describes the alpha feature in detail.

## Section B
Beta section body that describes the beta feature in detail.
`;

const IMPL_BAD = `# Impl

<!-- ref: design.md#missing-section claim="alpha feature" -->

Implementation referencing a section that does not exist.
`;

const IMPL_GOOD = `# Impl

<!-- ref: design.md#section-a claim="alpha feature" -->

Implementation that correctly cites section A from the design.
`;

async function setupWorkspace(): Promise<{ dir: string; workflowPath: string; artifactsDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "aow-citrec-"));
  workspaces.push(dir);
  const workflowPath = join(dir, "workflow.yaml");
  await writeFile(workflowPath, YAML, "utf8");
  const artifactsDir = join(dir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  return { dir, workflowPath, artifactsDir };
}

describe("citation recovery integration", () => {
  it("rejects bad citation, auto-revises with feedback, records hops, and --hops prints them", async () => {
    const ws = await setupWorkspace();
    const sessions = new Map<string, FakeSession>();
    const writeArt = (name: string, body: string): AgentScript => ({
      produce: async (_w, dir) => { await writeFile(join(dir, name), body, "utf8"); },
    });
    const scripts = [
      writeArt("design.md", DESIGN_CONTENT),
      writeArt("impl.md", IMPL_BAD),
      writeArt("impl.md", IMPL_GOOD),
    ];
    const spawn = makeSpawner(scripts, ws.artifactsDir, sessions);
    const aoFactory = async () => buildAoCtx(sessions, spawn);
    const runOpts = {
      workflowPath: ws.workflowPath, selector: { kind: "all" as const }, detach: true,
      aoContextFactory: aoFactory, completionPollIntervalMs: 5, completionIdleThresholdMs: 10,
    };

    // Single run: design completes, impl fails citations once, gets revised
    // automatically (Fix 3), and succeeds on attempt 2.
    const first = await runWorkflow(runOpts);
    expect(first.status).toBe("completed");
    const finalState = await loadRunState(first.runDir);
    expect(finalState.steps.design.status).toBe("completed");
    expect(finalState.steps.impl.status).toBe("completed");
    expect(finalState.steps.impl.attempts).toBe(2);

    // The first failed attempt is preserved in history with its lint report.
    const implHistory = finalState.steps.impl.history ?? [];
    expect(implHistory).toHaveLength(1);
    expect(implHistory[0].lint_report?.errors.some((e) => e.code === "section_not_found")).toBe(true);

    // Feedback file from the linter for the next attempt.
    const fb = await readFile(join(first.runDir, "feedback", "impl-attempt-2.md"), "utf8");
    expect(fb).toContain("section_not_found");

    // Retry prompt carries the prior-feedback preamble.
    expect(spawn).toHaveBeenCalledTimes(3); // design + impl x2
    const retryPrompt = (spawn.mock.calls[2][0] as { prompt: string }).prompt;
    expect(retryPrompt).toContain("PRIOR ATTEMPT FEEDBACK");
    expect(retryPrompt).toContain("section_not_found");

    // ref-hops.jsonl was written into each impl-attempt's workspace.
    const badHops = await readFile(join(sessions.get("ses-2")!.workspacePath, ".ao", "ref-hops.jsonl"), "utf8");
    const goodHops = await readFile(join(sessions.get("ses-3")!.workspacePath, ".ao", "ref-hops.jsonl"), "utf8");
    expect(badHops).toContain("missing-section");
    expect(goodHops).toContain("section-a");

    // `aow show --hops` smoke: capture stdout. State stores only the latest
    // attempt's session, so the printed trail is the successful one.
    const out = await captureStdout(() => withCwd(ws.dir, () =>
      showCmd(first.runId, { hops: true, aoContextFactory: aoFactory })));
    expect(out).toContain("Step: impl");
    expect(out).toContain("section-a");
    expect(out).toContain("design.md");
  });
});

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string | Uint8Array) => {
    chunks.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try { await fn(); } finally { process.stdout.write = orig; }
  return chunks.join("");
}

async function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const orig = process.cwd();
  process.chdir(dir);
  try { return await fn(); } finally { process.chdir(orig); }
}
