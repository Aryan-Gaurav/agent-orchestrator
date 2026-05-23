import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { lintStepCitations, type LintInputs } from "../citation-linter.js";
import { getBundledResolverScriptPath } from "../engine/workspace-setup.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "citation-linter", "fixtures");
const RESOLVER = getBundledResolverScriptPath();

const tmpDirs: string[] = [];

function newScratch(): { artifactsDir: string; workspacePath: string } {
  const root = mkdtempSync(join(tmpdir(), "aow-citlint-"));
  tmpDirs.push(root);
  const artifactsDir = join(root, "artifacts");
  const workspacePath = join(root, "ws");
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(workspacePath, { recursive: true });
  copyFileSync(join(FIXTURES, "design.md"), join(artifactsDir, "design.md"));
  return { artifactsDir, workspacePath };
}

function writeOutput(artifactsDir: string, name: string, content: string): string {
  const abs = join(artifactsDir, name);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return abs;
}

function baseInputs(
  scratch: { artifactsDir: string; workspacePath: string },
  outputFiles: string[],
  overrides: Partial<LintInputs> = {},
): LintInputs {
  return {
    artifactsDir: scratch.artifactsDir,
    workspacePath: scratch.workspacePath,
    stepId: "impl_plan",
    outputFiles,
    trackedInputCount: 0,
    resolverScriptPath: RESOLVER,
    ...overrides,
  };
}

afterAll(() => {
  // best-effort; tmpfs auto-cleans
});

describe("lintStepCitations — happy paths", () => {
  it("clean output with no citations returns empty report", async () => {
    const s = newScratch();
    const out = writeOutput(s.artifactsDir, "plan.md", "# Plan\n\nNo citations here.\n");
    const report = await lintStepCitations(baseInputs(s, [out]));
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it("valid <!-- ref --> with matching claim passes silently", async () => {
    const s = newScratch();
    const out = writeOutput(
      s.artifactsDir,
      "plan.md",
      `# Plan\n\nUse bcrypt. <!-- ref: design.md#auth-flow claim="bcrypt cost factor 12" -->\n`,
    );
    const report = await lintStepCitations(baseInputs(s, [out]));
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it("parses both <!-- ref --> and // ref: in the same file", async () => {
    const s = newScratch();
    const out = writeOutput(
      s.artifactsDir,
      "impl.md",
      `# Impl\n\n<!-- ref: design.md#auth-flow claim="bcrypt" -->\n\n\`\`\`ts\n// ref: design.md#data-retention claim="90 days"\n\`\`\`\n`,
    );
    const report = await lintStepCitations(baseInputs(s, [out]));
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
  });
});

describe("lintStepCitations — claim handling", () => {
  it("missing claim emits a warning, not an error", async () => {
    const s = newScratch();
    const out = writeOutput(
      s.artifactsDir,
      "plan.md",
      `# Plan\n<!-- ref: design.md#auth-flow -->\n`,
    );
    const report = await lintStepCitations(baseInputs(s, [out]));
    expect(report.errors).toEqual([]);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0].code).toBe("missing_claim");
  });

  it("token_overlap with confidence >= 0.7 emits warning", async () => {
    const s = newScratch();
    // 4 tokens, all should appear in section (bcrypt, factor, hash, sessions)
    const out = writeOutput(
      s.artifactsDir,
      "plan.md",
      `# Plan\n<!-- ref: design.md#auth-flow claim="bcrypt factor hash sessions" -->\n`,
    );
    const report = await lintStepCitations(baseInputs(s, [out]));
    expect(report.errors).toEqual([]);
    expect(
      report.warnings.some((w) => w.code === "claim_low_confidence"),
    ).toBe(true);
  });

  it("token_overlap with confidence in [0.5, 0.7) emits warning, NOT error", async () => {
    // Regression for Phase 3.11 post-merge bug: claim_low_confidence was
    // emitted as error when confidence < 0.7. The match itself is valid
    // (resolver returned found=true); low confidence is informational.
    // Run 7 dogfood failed tests step on confidence 0.57/0.67.
    const s = newScratch();
    const out = writeOutput(
      s.artifactsDir,
      "plan.md",
      `# Plan\n<!-- ref: design.md#auth-flow claim="bcrypt factor encrypted handshake" -->\n`,
    );
    const report = await lintStepCitations(baseInputs(s, [out]));
    expect(report.errors).toEqual([]);
    const lowConf = report.warnings.find((w) => w.code === "claim_low_confidence");
    expect(lowConf).toBeDefined();
    expect(lowConf?.kind).toBe("warning");
  });

  it("claim that does not match → claim_unfaithful error (LLM tier, stubbed)", async () => {
    // After Phase 3.12, a low-overlap claim is routed to the LLM tier instead
    // of failing as claim_mismatch directly. We stub the LLM verdict so the
    // test does not depend on the local `claude` CLI being installed.
    process.env.AOW_LLM_CHECK_STUB = "unfaithful";
    try {
      const s = newScratch();
      const out = writeOutput(
        s.artifactsDir,
        "plan.md",
        `# Plan\n<!-- ref: design.md#auth-flow claim="quantum entanglement" -->\n`,
      );
      const report = await lintStepCitations(baseInputs(s, [out]));
      expect(report.errors.some((e) => e.code === "claim_unfaithful")).toBe(true);
    } finally {
      delete process.env.AOW_LLM_CHECK_STUB;
    }
  });
});

describe("lintStepCitations — ref errors", () => {
  it("bad file ref → file_not_found error", async () => {
    const s = newScratch();
    const out = writeOutput(
      s.artifactsDir,
      "plan.md",
      `# Plan\n<!-- ref: nonexistent.md#anywhere claim="x" -->\n`,
    );
    const report = await lintStepCitations(baseInputs(s, [out]));
    expect(report.errors.some((e) => e.code === "file_not_found")).toBe(true);
  });

  it("bad section ref → section_not_found error", async () => {
    const s = newScratch();
    const out = writeOutput(
      s.artifactsDir,
      "plan.md",
      `# Plan\n<!-- ref: design.md#no-such-section claim="x" -->\n`,
    );
    const report = await lintStepCitations(baseInputs(s, [out]));
    expect(report.errors.some((e) => e.code === "section_not_found")).toBe(true);
  });

  it("path escape → outside_artifacts_dir error", async () => {
    const s = newScratch();
    const out = writeOutput(
      s.artifactsDir,
      "plan.md",
      `# Plan\n<!-- ref: ../escape.md#x claim="x" -->\n`,
    );
    const report = await lintStepCitations(baseInputs(s, [out]));
    expect(report.errors.some((e) => e.code === "outside_artifacts_dir")).toBe(
      true,
    );
  });
});

describe("lintStepCitations — density warnings", () => {
  it("2 tracked inputs and 0 citations → no_citations_but_inputs warning", async () => {
    const s = newScratch();
    const out = writeOutput(s.artifactsDir, "plan.md", "# Plan\n\nNo refs.\n");
    const report = await lintStepCitations(
      baseInputs(s, [out], { trackedInputCount: 2 }),
    );
    expect(
      report.warnings.some((w) => w.code === "no_citations_but_inputs"),
    ).toBe(true);
  });
});

describe("lintStepCitations — hop log", () => {
  it("hop log with 5 entries for the step → hop_depth_exceeded warning", async () => {
    const s = newScratch();
    const dotAo = join(s.workspacePath, ".ao");
    mkdirSync(dotAo, { recursive: true });
    const lines = Array.from({ length: 5 }, (_v, i) =>
      JSON.stringify({
        ts: new Date().toISOString(),
        step_id: "impl_plan",
        ref: `design.md#auth-flow#${i}`,
        outcome: "ok",
        match_kind: "exact_substring",
      }),
    );
    writeFileSync(join(dotAo, "ref-hops.jsonl"), lines.join("\n") + "\n", "utf8");
    const out = writeOutput(s.artifactsDir, "plan.md", "# Plan\n");
    const report = await lintStepCitations(baseInputs(s, [out]));
    expect(
      report.warnings.some((w) => w.code === "hop_depth_exceeded"),
    ).toBe(true);
  });

  it("missing hop log → no hop-depth finding", async () => {
    const s = newScratch();
    const out = writeOutput(s.artifactsDir, "plan.md", "# Plan\n");
    const report = await lintStepCitations(baseInputs(s, [out]));
    expect(
      report.warnings.some((w) => w.code === "hop_depth_exceeded"),
    ).toBe(false);
  });
});

describe("lintStepCitations — inputs plumbing (Fix 1)", () => {
  it("resolves a citation via the LintInputs.inputs alias when set", async () => {
    const s = newScratch();
    // Put requirements.md OUTSIDE the artifacts dir; the only way the
    // citation `requirements.md#out-of-scope` can resolve is via the inputs
    // alias.
    const externalDir = mkdtempSync(join(tmpdir(), "aow-ext-"));
    tmpDirs.push(externalDir);
    writeFileSync(
      join(externalDir, "requirements.md"),
      "# R\n\n## Out of scope\nbody\n",
      "utf8",
    );
    const out = writeOutput(
      s.artifactsDir,
      "plan.md",
      `# Plan\n<!-- ref: requirements.md#out-of-scope claim="body" -->\n`,
    );
    const report = await lintStepCitations(
      baseInputs(s, [out], {
        inputs: [{ name: "requirements", path: join(externalDir, "requirements.md") }],
      }),
    );
    expect(report.errors).toEqual([]);
  });

  it("without inputs alias, the same citation reports file_not_found", async () => {
    const s = newScratch();
    const out = writeOutput(
      s.artifactsDir,
      "plan.md",
      `# Plan\n<!-- ref: requirements.md#out-of-scope claim="body" -->\n`,
    );
    const report = await lintStepCitations(baseInputs(s, [out]));
    expect(report.errors.some((e) => e.code === "file_not_found")).toBe(true);
  });
});

describe("lintStepCitations — subprocess timeout", () => {
  it("hung resolver script → finding with detail 'resolver timeout'", async () => {
    const s = newScratch();
    const out = writeOutput(
      s.artifactsDir,
      "plan.md",
      `# Plan\n<!-- ref: design.md#auth-flow claim="x" -->\n`,
    );
    const report = await lintStepCitations(
      baseInputs(s, [out], {
        resolverScriptPath: join(FIXTURES, "hang.js"),
        resolverTimeoutMs: 250,
      }),
    );
    expect(
      report.errors.some(
        (e) => e.code === "file_not_found" && e.detail === "resolver timeout",
      ),
    ).toBe(true);
  });
});
