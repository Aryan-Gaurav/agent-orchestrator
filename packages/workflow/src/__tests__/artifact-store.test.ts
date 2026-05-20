import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  copyArtifact,
  hashFile,
  hashesEqual,
  resolveArtifactPath,
  verifyArtifact,
} from "../artifact-store.js";
import { ArtifactStoreError } from "../errors.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "aow-artifact-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("hashFile", () => {
  it("returns a stable sha256 hex digest for identical content", async () => {
    const a = join(workDir, "a.txt");
    const b = join(workDir, "b.txt");
    await writeFile(a, "hello world", "utf8");
    await writeFile(b, "hello world", "utf8");
    const ha = await hashFile(a);
    const hb = await hashFile(b);
    expect(ha).toBe(hb);
    expect(ha).toMatch(/^[0-9a-f]{64}$/);
    // Pinned digest of "hello world" so a regression in hashing surfaces.
    expect(ha).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
  });

  it("differs for different content", async () => {
    const a = join(workDir, "a.txt");
    const b = join(workDir, "b.txt");
    await writeFile(a, "first", "utf8");
    await writeFile(b, "second", "utf8");
    expect(await hashFile(a)).not.toBe(await hashFile(b));
  });

  it("throws ArtifactStoreError for non-absolute paths", async () => {
    await expect(hashFile("relative/path.txt")).rejects.toBeInstanceOf(
      ArtifactStoreError,
    );
  });

  it("throws ArtifactStoreError for missing files", async () => {
    await expect(
      hashFile(join(workDir, "does-not-exist")),
    ).rejects.toBeInstanceOf(ArtifactStoreError);
  });
});

describe("resolveArtifactPath", () => {
  it("joins relative paths against artifacts_dir", () => {
    const base = join(workDir, "artifacts");
    const resolved = resolveArtifactPath(base, "design.md");
    expect(resolved).toBe(join(base, "design.md"));
  });

  it("supports nested relative paths inside artifacts_dir", () => {
    const base = join(workDir, "artifacts");
    const resolved = resolveArtifactPath(base, join("nested", "doc.md"));
    expect(resolved).toBe(join(base, "nested", "doc.md"));
  });

  it("rejects parent-traversal segments that escape artifacts_dir", () => {
    const base = join(workDir, "artifacts");
    expect(() => resolveArtifactPath(base, `..${sep}escape.md`)).toThrow(
      ArtifactStoreError,
    );
    expect(() =>
      resolveArtifactPath(base, join("nested", "..", "..", "escape.md")),
    ).toThrow(ArtifactStoreError);
  });

  it("rejects absolute relPaths", () => {
    const base = join(workDir, "artifacts");
    const abs = join(workDir, "outside.md");
    expect(() => resolveArtifactPath(base, abs)).toThrow(ArtifactStoreError);
  });

  it("rejects empty paths", () => {
    expect(() => resolveArtifactPath(workDir, "")).toThrow(ArtifactStoreError);
  });
});

describe("copyArtifact", () => {
  it("copies the file and returns hash matching the source", async () => {
    const src = join(workDir, "src.md");
    const dest = join(workDir, "dest", "out.md");
    await writeFile(src, "payload contents", "utf8");
    const result = await copyArtifact(src, dest);
    expect(result.path).toBe(dest);
    const destContents = await readFile(dest, "utf8");
    expect(destContents).toBe("payload contents");
    const srcHash = await hashFile(src);
    expect(result.hash).toBe(srcHash);
  });

  it("creates missing parent directories for the destination", async () => {
    const src = join(workDir, "src.md");
    const dest = join(workDir, "deeply", "nested", "out.md");
    await writeFile(src, "x", "utf8");
    const { path } = await copyArtifact(src, dest);
    expect(path).toBe(dest);
    await expect(readFile(dest, "utf8")).resolves.toBe("x");
  });

  it("throws ArtifactStoreError when src is missing", async () => {
    const src = join(workDir, "missing.md");
    const dest = join(workDir, "dest.md");
    await expect(copyArtifact(src, dest)).rejects.toBeInstanceOf(
      ArtifactStoreError,
    );
  });
});

describe("verifyArtifact", () => {
  it("returns true when the hash matches", async () => {
    const file = join(workDir, "file.md");
    await writeFile(file, "match me", "utf8");
    const hash = await hashFile(file);
    expect(await verifyArtifact(file, hash)).toBe(true);
  });

  it("returns false when the hash does not match", async () => {
    const file = join(workDir, "file.md");
    await writeFile(file, "match me", "utf8");
    expect(await verifyArtifact(file, "0".repeat(64))).toBe(false);
  });
});

describe("hashesEqual", () => {
  it("returns true for equal strings", () => {
    expect(hashesEqual("abc123", "abc123")).toBe(true);
  });

  it("returns false for unequal same-length strings", () => {
    expect(hashesEqual("abc123", "abc124")).toBe(false);
  });

  it("returns false for different lengths without throwing", () => {
    expect(hashesEqual("abc", "abcd")).toBe(false);
    expect(hashesEqual("", "anything")).toBe(false);
  });
});
