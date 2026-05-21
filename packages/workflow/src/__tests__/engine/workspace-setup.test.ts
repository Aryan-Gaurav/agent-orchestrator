import { access, constants, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceSetupError } from "../../errors.js";
import {
  getBundledResolverScriptPath,
  installResolverScript,
} from "../../engine/workspace-setup.js";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "aow-ws-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
});

describe("installResolverScript", () => {
  it("requires the bundled resolver script to exist on disk", async () => {
    const source = getBundledResolverScriptPath();
    try {
      await access(source, constants.R_OK);
    } catch (err) {
      throw new Error(
        `Bundled resolver script missing at ${source}. Run \`pnpm --filter @aoagents/ao-workflow build\` before running these tests.`,
        { cause: err },
      );
    }
  });

  it("creates .ao/aow-ref inside the given workspace", async () => {
    await installResolverScript(workspace);
    const dest = join(workspace, ".ao", "aow-ref");
    await expect(access(dest)).resolves.toBeUndefined();
  });

  it("makes the destination file executable", async () => {
    await installResolverScript(workspace);
    const dest = join(workspace, ".ao", "aow-ref");
    const st = await stat(dest);
    expect(st.mode & 0o111).not.toBe(0);
  });

  it("copies the source script byte-for-byte", async () => {
    await installResolverScript(workspace);
    const dest = join(workspace, ".ao", "aow-ref");
    const sourceBytes = await readFile(getBundledResolverScriptPath());
    const destBytes = await readFile(dest);
    expect(destBytes.equals(sourceBytes)).toBe(true);
  });

  it("is idempotent — calling twice does not error", async () => {
    await installResolverScript(workspace);
    await expect(installResolverScript(workspace)).resolves.toBeUndefined();
  });

  it("throws WorkspaceSetupError when given a relative path", async () => {
    await expect(installResolverScript("relative/path")).rejects.toBeInstanceOf(
      WorkspaceSetupError,
    );
  });
});
