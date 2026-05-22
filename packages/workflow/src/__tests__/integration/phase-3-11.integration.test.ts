// Integration test for Phase 3.11:
//   Loose claim matching — paraphrased claim against a code-symbol anchor
//   resolves without errors (warning is acceptable).

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { lintStepCitations, type LintInputs } from "../../citation-linter.js";
import { getBundledResolverScriptPath } from "../../engine/workspace-setup.js";

const RESOLVER = getBundledResolverScriptPath();

function newScratch(): { artifactsDir: string; workspacePath: string } {
  const root = mkdtempSync(join(tmpdir(), "aow-3-11-"));
  const artifactsDir = join(root, "artifacts");
  const workspacePath = join(root, "ws");
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(workspacePath, { recursive: true });
  return { artifactsDir, workspacePath };
}

function baseInputs(
  scratch: { artifactsDir: string; workspacePath: string },
  outputFiles: string[],
): LintInputs {
  return {
    artifactsDir: scratch.artifactsDir,
    workspacePath: scratch.workspacePath,
    stepId: "phase-3-11-tests",
    outputFiles,
    trackedInputCount: 1,
    resolverScriptPath: RESOLVER,
  };
}

describe("phase 3.11 — citation linter accepts paraphrased claims", () => {
  it("accepts a paraphrased claim against a Markdown section", async () => {
    const s = newScratch();

    writeFileSync(
      join(s.artifactsDir, "hld.md"),
      [
        "# HLD",
        "",
        "## Shortener",
        "",
        "Orchestrates the write path: generate a random 7-char base62 code,",
        "ask the ring for the owning shard, attempt setIfAbsent, retry on",
        "collision up to 5 times.",
        "",
      ].join("\n"),
      "utf8",
    );

    const out = join(s.artifactsDir, "notes.md");
    writeFileSync(
      out,
      '<!-- ref: hld.md#shortener claim="Shortener generates random 7-char base62 code, routes via ring, setIfAbsent with retry up to 5x" -->\n',
      "utf8",
    );

    const report = await lintStepCitations(baseInputs(s, [out]));
    expect(report.errors).toEqual([]);
  });

  it("accepts a paraphrased claim against a code-symbol anchor", async () => {
    const s = newScratch();
    mkdirSync(join(s.artifactsDir, "src"), { recursive: true });
    mkdirSync(join(s.artifactsDir, "__tests__"), { recursive: true });

    writeFileSync(
      join(s.artifactsDir, "src", "Shortener.ts"),
      [
        "export function generateCode(): string {",
        "  // generate a random 7-char base62 code and return it",
        '  return "abcdefg";',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const testFile = join(s.artifactsDir, "__tests__", "Shortener.test.ts");
    writeFileSync(
      testFile,
      [
        '// ref: src/Shortener.ts#generateCode claim="generates random base62 code"',
        'import { generateCode } from "../src/Shortener.js";',
        "",
        "export const sample = generateCode;",
        "",
      ].join("\n"),
      "utf8",
    );

    const report = await lintStepCitations(baseInputs(s, [testFile]));
    expect(report.errors).toEqual([]);
  });
});
