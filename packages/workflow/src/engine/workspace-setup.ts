// Drops the bundled resolver script into a spawned agent's worktree at
// `<workspacePath>/.ao/aow-ref` so the agent can run it as a local tool.
// Used by step-runner immediately after spawnAgentSession returns.

import { access, chmod, copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WorkspaceSetupError } from "../errors.js";

export function getBundledResolverScriptPath(): string {
  // After build, `import.meta.url` is dist/engine/workspace-setup.js, so the
  // adjacent resolver lives at dist/resolver/script.js. Under vitest the same
  // URL resolution returns src/resolver/script.js which has no built artifact;
  // in that case, fall back to dist/resolver/script.js at the package root.
  const adjacent = fileURLToPath(new URL("../resolver/script.js", import.meta.url));
  if (existsSync(adjacent)) return adjacent;
  return fileURLToPath(
    new URL("../../dist/resolver/script.js", import.meta.url),
  );
}

export async function installResolverScript(workspacePath: string): Promise<void> {
  if (!isAbsolute(workspacePath)) {
    throw new WorkspaceSetupError(
      `workspacePath must be absolute, got: ${workspacePath}`,
    );
  }

  const source = getBundledResolverScriptPath();
  try {
    await access(source);
  } catch (err) {
    throw new WorkspaceSetupError(
      `bundled resolver script missing at ${source} — did you build?`,
      { cause: err },
    );
  }

  const dotAo = join(workspacePath, ".ao");
  const dest = join(dotAo, "aow-ref");
  try {
    await mkdir(dotAo, { recursive: true });
    await copyFile(source, dest);
    await chmod(dest, 0o755);
  } catch (err) {
    throw new WorkspaceSetupError(
      `failed to install resolver script into ${dest}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}
