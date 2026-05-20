import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { ArtifactStoreError } from "./errors.js";

export interface CopyArtifactResult {
  path: string;
  hash: string;
}

export async function hashFile(absPath: string): Promise<string> {
  if (!isAbsolute(absPath)) {
    throw new ArtifactStoreError(
      `hashFile requires an absolute path; got "${absPath}"`,
    );
  }
  try {
    const stats = await stat(absPath);
    if (!stats.isFile()) {
      throw new ArtifactStoreError(
        `Cannot hash non-regular file at ${absPath}`,
      );
    }
  } catch (err) {
    if (err instanceof ArtifactStoreError) throw err;
    throw new ArtifactStoreError(`Cannot stat file at ${absPath}`, {
      cause: err instanceof Error ? err : undefined,
    });
  }

  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const stream = createReadStream(absPath);
    stream.on("error", (err) => {
      rejectPromise(
        new ArtifactStoreError(`Failed reading ${absPath} while hashing`, {
          cause: err,
        }),
      );
    });
    stream.on("data", (chunk) => {
      hash.update(chunk);
    });
    stream.on("end", () => {
      resolvePromise(hash.digest("hex"));
    });
  });
}

export function resolveArtifactPath(
  artifactsDir: string,
  relPath: string,
): string {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new ArtifactStoreError("Artifact path must be a non-empty string");
  }
  if (isAbsolute(relPath)) {
    throw new ArtifactStoreError(
      `Artifact path must be relative to artifacts_dir; got absolute "${relPath}"`,
    );
  }
  const baseAbs = resolve(artifactsDir);
  const targetAbs = resolve(baseAbs, relPath);
  const rel = relative(baseAbs, targetAbs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    if (rel === "") {
      throw new ArtifactStoreError(
        `Artifact path "${relPath}" resolves to the artifacts directory itself`,
      );
    }
    throw new ArtifactStoreError(
      `Artifact path "${relPath}" escapes artifacts directory "${artifactsDir}"`,
    );
  }
  return targetAbs;
}

export async function copyArtifact(
  src: string,
  dest: string,
): Promise<CopyArtifactResult> {
  if (!isAbsolute(src)) {
    throw new ArtifactStoreError(
      `copyArtifact requires absolute src path; got "${src}"`,
    );
  }
  if (!isAbsolute(dest)) {
    throw new ArtifactStoreError(
      `copyArtifact requires absolute dest path; got "${dest}"`,
    );
  }

  try {
    await mkdir(dirname(dest), { recursive: true });
  } catch (err) {
    throw new ArtifactStoreError(
      `Failed to create destination directory for ${dest}`,
      { cause: err instanceof Error ? err : undefined },
    );
  }

  try {
    await copyFile(src, dest);
  } catch (err) {
    throw new ArtifactStoreError(`Failed to copy ${src} -> ${dest}`, {
      cause: err instanceof Error ? err : undefined,
    });
  }

  const hash = await hashFile(dest);
  return { path: dest, hash };
}

export async function verifyArtifact(
  absPath: string,
  expectedHash: string,
): Promise<boolean> {
  const actual = await hashFile(absPath);
  return hashesEqual(actual, expectedHash);
}

export function hashesEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
