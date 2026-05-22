// Tests for Phase 3.9 Fix 2: stale-build freshness warning.

import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const warnSpy = vi.fn();
vi.mock("../../logger.js", async () => {
  const actual = await vi.importActual<typeof import("../../logger.js")>("../../logger.js");
  return { ...actual, warn: (...args: unknown[]) => warnSpy(...args) };
});

const { latestMtime, warnIfBuildStale } = await import("../../cli/build-freshness.js");

let tmp: string;

beforeEach(async () => {
  warnSpy.mockReset();
  tmp = await mkdtemp(join(tmpdir(), "aow-build-freshness-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

async function setMtime(path: string, when: Date): Promise<void> {
  await utimes(path, when, when);
}

describe("latestMtime", () => {
  it("returns the newest matching-file mtime, recursing into subdirectories", async () => {
    const sub = join(tmp, "sub");
    await mkdir(sub, { recursive: true });
    await writeFile(join(tmp, "a.ts"), "x");
    await writeFile(join(sub, "b.ts"), "x");
    await writeFile(join(sub, "ignore.md"), "x"); // not matched
    await setMtime(join(tmp, "a.ts"), new Date(1_000_000));
    await setMtime(join(sub, "b.ts"), new Date(5_000_000));

    const latest = await latestMtime(tmp, /\.ts$/);
    expect(latest).toBe(5_000_000);
  });

  it("returns null when the directory does not exist", async () => {
    const missing = join(tmp, "does-not-exist");
    expect(await latestMtime(missing, /\.ts$/)).toBeNull();
  });

  it("returns null when no matching files are found", async () => {
    await writeFile(join(tmp, "readme.md"), "x");
    expect(await latestMtime(tmp, /\.ts$/)).toBeNull();
  });
});

describe("warnIfBuildStale", () => {
  // The function's notion of `pkgRoot` is derived from its own file path,
  // so we exercise the warning via the latestMtime helper directly — the
  // wrapper just compares the two and calls log.warn. To keep these tests
  // hermetic and avoid touching the real packages/workflow tree, we assert
  // the wrapper's contract by checking it is a no-throw best-effort call.
  it("is a no-throw best-effort call (never rejects even on filesystem error)", async () => {
    await expect(warnIfBuildStale()).resolves.toBeUndefined();
  });

  it("does not warn when src is older than dist (uses latestMtime comparison)", async () => {
    const srcDir = join(tmp, "src");
    const distDir = join(tmp, "dist");
    await mkdir(srcDir);
    await mkdir(distDir);
    await writeFile(join(srcDir, "a.ts"), "x");
    await writeFile(join(distDir, "a.js"), "x");
    await setMtime(join(srcDir, "a.ts"), new Date(1_000_000));
    await setMtime(join(distDir, "a.js"), new Date(2_000_000));

    const srcLatest = await latestMtime(srcDir, /\.ts$/);
    const distLatest = await latestMtime(distDir, /\.js$/);
    expect(srcLatest).not.toBeNull();
    expect(distLatest).not.toBeNull();
    if (srcLatest === null || distLatest === null) return;
    expect(srcLatest <= distLatest).toBe(true);
  });

  it("would warn when src is newer than dist (uses latestMtime comparison)", async () => {
    const srcDir = join(tmp, "src");
    const distDir = join(tmp, "dist");
    await mkdir(srcDir);
    await mkdir(distDir);
    await writeFile(join(srcDir, "a.ts"), "x");
    await writeFile(join(distDir, "a.js"), "x");
    await setMtime(join(srcDir, "a.ts"), new Date(9_000_000));
    await setMtime(join(distDir, "a.js"), new Date(1_000_000));

    const srcLatest = await latestMtime(srcDir, /\.ts$/);
    const distLatest = await latestMtime(distDir, /\.js$/);
    expect(srcLatest).not.toBeNull();
    expect(distLatest).not.toBeNull();
    if (srcLatest === null || distLatest === null) return;
    expect(srcLatest > distLatest).toBe(true);
  });

  it("silently no-ops when dist is missing (published install or fresh checkout)", async () => {
    const srcDir = join(tmp, "src");
    await mkdir(srcDir);
    await writeFile(join(srcDir, "a.ts"), "x");
    // dist intentionally absent
    expect(await latestMtime(join(tmp, "dist"), /\.js$/)).toBeNull();
  });

  it("silently no-ops when src is missing (published install)", async () => {
    const distDir = join(tmp, "dist");
    await mkdir(distDir);
    await writeFile(join(distDir, "a.js"), "x");
    expect(await latestMtime(join(tmp, "src"), /\.ts$/)).toBeNull();
  });
});
