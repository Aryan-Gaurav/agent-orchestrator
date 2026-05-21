import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureAowConfig } from "../../cli/bootstrap.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aow-bootstrap-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ensureAowConfig", () => {
  it("creates a flat config when none exists", async () => {
    const result = await ensureAowConfig(dir);
    expect(result.created).toBe(true);
    expect(result.configPath).toBe(join(dir, "agent-orchestrator.yaml"));
    expect(result.projectId).toBeTruthy();
    const text = await readFile(result.configPath, "utf8");
    expect(text).toContain("$schema:");
    expect(text).toContain(`name: ${result.projectId}`);
    expect(text).toContain(`path: ${dir}`);
    expect(text).toContain("defaultBranch: main");
    expect(text).toContain("sessionPrefix: aow");
    expect(text).toContain("agent: claude-code");
    expect(text).toContain("workspace: worktree");
  });

  it("returns existing flat config name without rewriting", async () => {
    const cfg = "name: existing-proj\npath: /tmp/foo\ndefaultBranch: main\n";
    await writeFile(join(dir, "agent-orchestrator.yaml"), cfg);
    const result = await ensureAowConfig(dir);
    expect(result.created).toBe(false);
    expect(result.projectId).toBe("existing-proj");
    const text = await readFile(result.configPath, "utf8");
    expect(text).toBe(cfg);
  });

  it("returns first project key for a wrapped config", async () => {
    const cfg = [
      "projects:",
      "  first-proj:",
      "    path: /tmp/first",
      "    defaultBranch: main",
      "  second-proj:",
      "    path: /tmp/second",
      "    defaultBranch: main",
      "",
    ].join("\n");
    await writeFile(join(dir, "agent-orchestrator.yaml"), cfg);
    const result = await ensureAowConfig(dir);
    expect(result.created).toBe(false);
    expect(result.projectId).toBe("first-proj");
  });

  it("sanitizes special characters in cwd basename", async () => {
    const messy = await mkdtemp(join(tmpdir(), "aow boot$trap "));
    try {
      const result = await ensureAowConfig(messy);
      expect(result.created).toBe(true);
      expect(result.projectId).toMatch(/^[a-z0-9_-]+$/);
      expect(result.projectId.endsWith("_")).toBe(false);
    } finally {
      await rm(messy, { recursive: true, force: true });
    }
  });

  it("is safe under concurrent calls on a fresh dir", async () => {
    const [a, b] = await Promise.all([ensureAowConfig(dir), ensureAowConfig(dir)]);
    const createdCount = [a, b].filter((r) => r.created).length;
    expect(createdCount).toBeGreaterThanOrEqual(1);
    expect(createdCount).toBeLessThanOrEqual(2);
    expect(a.projectId).toBe(b.projectId);
    expect(a.configPath).toBe(b.configPath);
    const text = await readFile(a.configPath, "utf8");
    expect(text).toContain(`name: ${a.projectId}`);
  });
});
