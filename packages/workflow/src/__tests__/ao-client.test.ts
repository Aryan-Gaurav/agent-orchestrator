import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfig = vi.fn();
const createPluginRegistry = vi.fn();
const createSessionManager = vi.fn();
const createLifecycleManager = vi.fn();

vi.mock("@aoagents/ao-core", () => ({
  loadConfig,
  createPluginRegistry,
  createSessionManager,
  createLifecycleManager,
}));

// Imported after vi.mock so the module picks up the mocked symbols.
const aoClient = await import("../ao-client.js");
const {
  _resetAoContextCacheForTests,
  createAoContext,
  getSessionStatus,
  killSession,
  spawnAgentSession,
} = aoClient;
type AoContext = Awaited<ReturnType<typeof createAoContext>>;
const { AoContextError } = await import("../errors.js");

interface MockSessionManager {
  spawn: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
}

interface MockLifecycleManager {
  start: ReturnType<typeof vi.fn>;
}

function makeMockSm(overrides: Partial<MockSessionManager> = {}): MockSessionManager {
  return {
    spawn: vi.fn(),
    get: vi.fn(),
    kill: vi.fn(),
    ...overrides,
  };
}

function makeMockLm(): MockLifecycleManager {
  return { start: vi.fn() };
}

function makeMockRegistry(): { loadFromConfig: ReturnType<typeof vi.fn> } {
  return { loadFromConfig: vi.fn().mockResolvedValue(undefined) };
}

beforeEach(() => {
  _resetAoContextCacheForTests();
  loadConfig.mockReset();
  createPluginRegistry.mockReset();
  createSessionManager.mockReset();
  createLifecycleManager.mockReset();
});

describe("createAoContext", () => {
  it("loads config, builds registry, and wires sm + lm for a known project", async () => {
    const config = {
      configPath: "/cfg.yaml",
      projects: { "proj-a": { name: "proj-a" } },
    };
    const registry = makeMockRegistry();
    const sm = makeMockSm();
    const lm = makeMockLm();
    loadConfig.mockResolvedValueOnce(config);
    createPluginRegistry.mockReturnValueOnce(registry);
    createSessionManager.mockReturnValueOnce(sm);
    createLifecycleManager.mockReturnValueOnce(lm);

    const ctx = await createAoContext("proj-a");

    expect(ctx.config).toBe(config);
    expect(ctx.sm).toBe(sm);
    expect(ctx.lm).toBe(lm);
    expect(registry.loadFromConfig).toHaveBeenCalledWith(config);
    expect(createSessionManager).toHaveBeenCalledWith({ config, registry });
    expect(createLifecycleManager).toHaveBeenCalledWith({
      config,
      registry,
      sessionManager: sm,
      projectId: "proj-a",
    });
  });

  it("throws AoContextError when project is not present in the AO config", async () => {
    loadConfig.mockResolvedValueOnce({
      configPath: "/cfg.yaml",
      projects: { other: {} },
    });

    await expect(createAoContext("missing")).rejects.toBeInstanceOf(AoContextError);
  });

  it("caches the context per projectId across calls", async () => {
    const config = {
      configPath: "/cfg.yaml",
      projects: { p: {} },
    };
    loadConfig.mockResolvedValue(config);
    createPluginRegistry.mockReturnValue(makeMockRegistry());
    createSessionManager.mockReturnValue(makeMockSm());
    createLifecycleManager.mockReturnValue(makeMockLm());

    const a = await createAoContext("p");
    const b = await createAoContext("p");

    expect(a).toBe(b);
    expect(loadConfig).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed context — the next call retries", async () => {
    loadConfig.mockRejectedValueOnce(new Error("boom"));
    await expect(createAoContext("p")).rejects.toBeInstanceOf(AoContextError);

    // Second call: succeed.
    const config = { configPath: "/cfg.yaml", projects: { p: {} } };
    loadConfig.mockResolvedValueOnce(config);
    createPluginRegistry.mockReturnValueOnce(makeMockRegistry());
    createSessionManager.mockReturnValueOnce(makeMockSm());
    createLifecycleManager.mockReturnValueOnce(makeMockLm());

    const ctx = await createAoContext("p");
    expect(ctx.config).toBe(config);
  });
});

describe("spawnAgentSession", () => {
  it("delegates to sm.spawn with the workflow step args and returns sessionId + branch", async () => {
    const sm = makeMockSm({
      spawn: vi.fn().mockResolvedValueOnce({ id: "ses-42", branch: "aow-x" }),
    });
    const ctx = { sm, lm: makeMockLm(), config: {} } as unknown as AoContext;

    const result = await spawnAgentSession(ctx, {
      projectId: "proj-a",
      agent: "claude-code",
      branch: "aow-x",
      prompt: "do thing",
    });

    expect(sm.spawn).toHaveBeenCalledWith({
      projectId: "proj-a",
      agent: "claude-code",
      branch: "aow-x",
      prompt: "do thing",
    });
    expect(result).toEqual({ sessionId: "ses-42", branch: "aow-x" });
  });

  it("falls back to the requested branch when the session reports a null branch", async () => {
    const sm = makeMockSm({
      spawn: vi.fn().mockResolvedValueOnce({ id: "ses-9", branch: null }),
    });
    const ctx = { sm, lm: makeMockLm(), config: {} } as unknown as AoContext;

    const result = await spawnAgentSession(ctx, {
      projectId: "p",
      agent: "claude-code",
      branch: "fallback-branch",
      prompt: "hi",
    });

    expect(result.branch).toBe("fallback-branch");
  });
});

describe("getSessionStatus", () => {
  it("maps Session -> { status, activity, lastActivityAt }", async () => {
    const lastActivityAt = new Date("2026-05-20T12:00:00Z");
    const sm = makeMockSm({
      get: vi.fn().mockResolvedValueOnce({
        id: "ses-1",
        status: "working",
        activity: "active",
        lastActivityAt,
      }),
    });
    const ctx = { sm, lm: makeMockLm(), config: {} } as unknown as AoContext;

    const snap = await getSessionStatus(ctx, "ses-1");

    expect(sm.get).toHaveBeenCalledWith("ses-1");
    expect(snap).toEqual({
      status: "working",
      activity: "active",
      lastActivityAt: lastActivityAt.toISOString(),
    });
  });

  it("returns null when sm.get reports the session no longer exists", async () => {
    const sm = makeMockSm({ get: vi.fn().mockResolvedValueOnce(null) });
    const ctx = { sm, lm: makeMockLm(), config: {} } as unknown as AoContext;

    await expect(getSessionStatus(ctx, "gone")).resolves.toBeNull();
  });
});

describe("killSession", () => {
  it("calls sm.kill with the supplied reason", async () => {
    const sm = makeMockSm({ kill: vi.fn().mockResolvedValueOnce(undefined) });
    const ctx = { sm, lm: makeMockLm(), config: {} } as unknown as AoContext;

    await killSession(ctx, "ses-1", "manually_killed");

    expect(sm.kill).toHaveBeenCalledWith("ses-1", { reason: "manually_killed" });
  });

  it("omits the reason option when none is provided", async () => {
    const sm = makeMockSm({ kill: vi.fn().mockResolvedValueOnce(undefined) });
    const ctx = { sm, lm: makeMockLm(), config: {} } as unknown as AoContext;

    await killSession(ctx, "ses-1");

    expect(sm.kill).toHaveBeenCalledWith("ses-1", undefined);
  });
});
