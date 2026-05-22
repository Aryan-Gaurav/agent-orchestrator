// Best-effort warning when packages/workflow/dist is older than src/.
// Catches the common footgun where `git pull` lands new workflow source but
// `aow` keeps running stale compiled output until the user rebuilds.

import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as log from "../logger.js";

export async function warnIfBuildStale(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url)); // .../packages/workflow/dist/cli
  const pkgRoot = dirname(dirname(here));                // .../packages/workflow
  const srcDir = join(pkgRoot, "src");
  const distDir = join(pkgRoot, "dist");

  try {
    const [srcLatest, distLatest] = await Promise.all([
      latestMtime(srcDir, /\.ts$/),
      latestMtime(distDir, /\.js$/),
    ]);
    if (srcLatest === null || distLatest === null) return;
    if (srcLatest <= distLatest) return;
    log.warn(
      `workflow source is newer than dist (src: ${new Date(srcLatest).toISOString()}, dist: ${new Date(distLatest).toISOString()})`,
    );
    log.warn("run: pnpm --filter @aoagents/ao-workflow build");
  } catch {
    // Best effort — never block command execution on a freshness check.
  }
}

export async function latestMtime(dir: string, pattern: RegExp): Promise<number | null> {
  let latest = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = await latestMtime(p, pattern);
        if (sub !== null && sub > latest) latest = sub;
      } else if (pattern.test(entry.name)) {
        const s = await stat(p);
        if (s.mtimeMs > latest) latest = s.mtimeMs;
      }
    }
  } catch {
    return null;
  }
  return latest > 0 ? latest : null;
}
