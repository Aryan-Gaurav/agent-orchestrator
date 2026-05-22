// Integration test for Phase 3.10:
//   Resolver supports code-symbol anchors for .ts/.tsx/.js/.jsx (and friends).
// End-to-end: spawn the bundled resolver script via the citation linter,
// lint a synthetic test file whose `// ref:` cites `src/Foo.ts#bar`.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { lintStepCitations, type LintInputs } from "../../citation-linter.js";
import { getBundledResolverScriptPath } from "../../engine/workspace-setup.js";

const RESOLVER = getBundledResolverScriptPath();

function newScratch(): { artifactsDir: string; workspacePath: string } {
  const root = mkdtempSync(join(tmpdir(), "aow-3-10-"));
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
    stepId: "phase-3-10-tests",
    outputFiles,
    trackedInputCount: 1,
    resolverScriptPath: RESOLVER,
  };
}

describe("phase 3.10 — citation linter accepts code-symbol anchors", () => {
  it("passes when a test file cites a function defined in the cited file", async () => {
    const s = newScratch();
    mkdirSync(join(s.artifactsDir, "src"), { recursive: true });
    mkdirSync(join(s.artifactsDir, "__tests__"), { recursive: true });

    writeFileSync(
      join(s.artifactsDir, "src", "Foo.ts"),
      [
        "export function bar(input: string): string {",
        "  // returns the input doubled",
        '  return input + input;',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const testFile = join(s.artifactsDir, "__tests__", "Foo.test.ts");
    writeFileSync(
      testFile,
      [
        '// ref: src/Foo.ts#bar claim="returns the input doubled"',
        'import { bar } from "../src/Foo.js";',
        "",
        "// trivial test placeholder",
        "export const sample = bar;",
        "",
      ].join("\n"),
      "utf8",
    );

    const report = await lintStepCitations(baseInputs(s, [testFile]));
    expect(report.errors).toEqual([]);
  });

  it("reports section_not_found with available symbols when the function does not exist", async () => {
    const s = newScratch();
    mkdirSync(join(s.artifactsDir, "src"), { recursive: true });

    writeFileSync(
      join(s.artifactsDir, "src", "Foo.ts"),
      "export function bar() { return 1; }\nexport function baz() { return 2; }\n",
      "utf8",
    );

    const out = join(s.artifactsDir, "notes.md");
    writeFileSync(
      out,
      '<!-- ref: src/Foo.ts#nope claim="missing" -->\n',
      "utf8",
    );

    const report = await lintStepCitations(baseInputs(s, [out]));
    const err = report.errors.find((e) => e.code === "section_not_found");
    expect(err).toBeTruthy();
    expect(err?.detail).toContain("bar");
    expect(err?.detail).toContain("baz");
  });
});
