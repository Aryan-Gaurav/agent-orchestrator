// Phase 3.12 integration test — LLM fallback for very-low-confidence claims.
//
// The citation linter spawns the bundled resolver as a subprocess. We can't
// reach across that process boundary with vi.mock, so we use the AOW_LLM_CHECK_STUB
// env var (a documented test seam in llm-check.ts) to control the verdict.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { lintStepCitations, type LintInputs } from "../../citation-linter.js";
import { getBundledResolverScriptPath } from "../../engine/workspace-setup.js";

const RESOLVER = getBundledResolverScriptPath();

function newScratch(): { artifactsDir: string; workspacePath: string } {
  const root = mkdtempSync(join(tmpdir(), "aow-3-12-"));
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
    stepId: "phase-3-12-tests",
    outputFiles,
    trackedInputCount: 1,
    resolverScriptPath: RESOLVER,
  };
}

// A claim with very-low (<0.3) token overlap with the section body.
// Section talks about ring/hash/shards; claim invents RAFT/paxos/quorum.
const LOW_OVERLAP_SECTION = [
  "# HashRing",
  "",
  "## ring",
  "",
  "HashRing distributes keys across shards using a ring-based scheme.",
  "",
].join("\n");
const LOW_OVERLAP_CLAIM =
  "implements RAFT consensus protocol with paxos quorum voting";

beforeEach(() => {
  delete process.env.AOW_LLM_CHECK_STUB;
});
afterEach(() => {
  delete process.env.AOW_LLM_CHECK_STUB;
});

describe("phase 3.12 — LLM fallback for low-overlap claims", () => {
  it("stub=faithful → lint passes cleanly (no findings)", async () => {
    process.env.AOW_LLM_CHECK_STUB = "faithful";
    const s = newScratch();
    writeFileSync(join(s.artifactsDir, "hld.md"), LOW_OVERLAP_SECTION, "utf8");
    const out = join(s.artifactsDir, "notes.md");
    writeFileSync(
      out,
      `<!-- ref: hld.md#ring claim="${LOW_OVERLAP_CLAIM}" -->\n`,
      "utf8",
    );
    const report = await lintStepCitations(baseInputs(s, [out]));
    expect(report.errors).toEqual([]);
    // No claim_low_confidence warning either — llm_verified is a clean pass.
    expect(
      report.warnings.filter((w) => w.code === "claim_low_confidence"),
    ).toEqual([]);
  });

  it("stub=unfaithful → lint emits claim_unfaithful error with the reason", async () => {
    process.env.AOW_LLM_CHECK_STUB = "unfaithful";
    const s = newScratch();
    writeFileSync(join(s.artifactsDir, "hld.md"), LOW_OVERLAP_SECTION, "utf8");
    const out = join(s.artifactsDir, "notes.md");
    writeFileSync(
      out,
      `<!-- ref: hld.md#ring claim="${LOW_OVERLAP_CLAIM}" -->\n`,
      "utf8",
    );
    const report = await lintStepCitations(baseInputs(s, [out]));
    const errs = report.errors.filter((e) => e.code === "claim_unfaithful");
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toContain("stubbed: unfaithful");
  });

  it("stub=null (unavailable) → lint passes with claim_low_confidence warning", async () => {
    process.env.AOW_LLM_CHECK_STUB = "null";
    const s = newScratch();
    writeFileSync(join(s.artifactsDir, "hld.md"), LOW_OVERLAP_SECTION, "utf8");
    const out = join(s.artifactsDir, "notes.md");
    writeFileSync(
      out,
      `<!-- ref: hld.md#ring claim="${LOW_OVERLAP_CLAIM}" -->\n`,
      "utf8",
    );
    const report = await lintStepCitations(baseInputs(s, [out]));
    expect(report.errors).toEqual([]);
    const warns = report.warnings.filter(
      (w) => w.code === "claim_low_confidence",
    );
    expect(warns).toHaveLength(1);
    expect(warns[0].message.toLowerCase()).toContain("unavailable");
  });

  it("regression: overlap ≥ 0.3 → LLM checker MUST NOT be called", async () => {
    // Sabotage the stub: if the LLM is consulted, the stub returns "unfaithful"
    // which would surface a claim_unfaithful error. So if the test passes
    // cleanly, the LLM was never reached.
    process.env.AOW_LLM_CHECK_STUB = "unfaithful";
    const s = newScratch();
    writeFileSync(
      join(s.artifactsDir, "hld.md"),
      [
        "# HLD",
        "",
        "## ring",
        "",
        "HashRing distributes keys across shards using a ring scheme.",
        "",
      ].join("\n"),
      "utf8",
    );
    const out = join(s.artifactsDir, "notes.md");
    // High overlap: every meaningful token appears in the section.
    writeFileSync(
      out,
      '<!-- ref: hld.md#ring claim="HashRing distributes keys across shards using ring" -->\n',
      "utf8",
    );
    const report = await lintStepCitations(baseInputs(s, [out]));
    expect(
      report.errors.filter((e) => e.code === "claim_unfaithful"),
    ).toEqual([]);
  });
});
