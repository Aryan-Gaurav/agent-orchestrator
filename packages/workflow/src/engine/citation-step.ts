// Citation-lint helpers used by step-runner. Pulled out to keep step-runner
// under the per-file LOC cap. No state of its own — pure functions plus the
// feedback-file writer.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  lintStepCitations,
  type CitationFinding,
  type LintReport,
} from "../citation-linter.js";
import * as log from "../logger.js";
import type {
  AgentStep,
  PersistedLintReport,
} from "../types.js";
import { getBundledResolverScriptPath } from "./workspace-setup.js";

export interface CitationLintArgs {
  step: AgentStep;
  artifactsDir: string;
  workspacePath: string | null;
  outputAbsPaths: string[];
  inputs: Array<{ name: string; absPath: string }>;
}

export async function runCitationLint(args: CitationLintArgs): Promise<LintReport> {
  if (!args.workspacePath) {
    return { errors: [], warnings: [] };
  }
  const trackedInputCount = Object.keys(args.step.inputs ?? {}).length;
  try {
    return await lintStepCitations({
      artifactsDir: args.artifactsDir,
      workspacePath: args.workspacePath,
      stepId: args.step.id,
      outputFiles: args.outputAbsPaths,
      trackedInputCount,
      resolverScriptPath: getBundledResolverScriptPath(),
      inputs: args.inputs.map((i) => ({ name: i.name, path: i.absPath })),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn(`[${args.step.id}] citation linter crashed: ${reason}`);
    return { errors: [], warnings: [] };
  }
}

export function formatFinding(f: CitationFinding): string {
  const ref = f.ref ? `:${f.ref}` : "";
  const detail = f.detail ? `\n    ${f.detail}` : "";
  return `- [${f.code}] ${f.outputFile}${ref} — ${f.message}${detail}`;
}

export function toPersistedReport(report: LintReport): PersistedLintReport {
  const cleanse = (f: CitationFinding) => ({
    kind: f.kind,
    code: f.code,
    outputFile: f.outputFile,
    ref: f.ref,
    claim: f.claim,
    message: f.message,
    detail: f.detail,
  });
  return {
    errors: report.errors.map(cleanse),
    warnings: report.warnings.map(cleanse),
  };
}

export function logLintErrors(stepId: string, report: LintReport): void {
  const total = report.errors.length;
  const shown = report.errors.slice(0, 5);
  log.error(`[${stepId}] citation lint errors (${total}):`);
  for (const f of shown) log.error(`  ${formatFinding(f)}`);
  if (total > shown.length) {
    log.error(`  ... and ${total - shown.length} more (see state.json lint_report)`);
  }
}

export async function writeCitationFeedback(
  runDir: string,
  stepId: string,
  nextAttempt: number,
  report: LintReport,
): Promise<void> {
  const sections: string[] = [
    "Citation linter rejected the previous attempt. Address EVERY error below before re-submitting.",
    "",
    "How to fix each error code:",
    "- section_not_found — your `#<slug>` does not exist in the cited file. The `available:` line lists every real slug. Pick one of those OR remove the citation if no section is relevant. Do NOT invent a new slug or re-submit the same one.",
    "- ambiguous_section — your `#<slug>` matches multiple headings. Make it more specific (add more `-token`s from the heading you mean) OR remove the citation.",
    "- claim_unfaithful / claim_mismatch — the section is real but the `claim=` text is not supported by it. Either restate the claim using the section's actual words, or remove the citation.",
    "- file_not_found / outside_artifacts_dir / malformed_ref — the citation target is wrong; fix the path or drop the citation.",
    "",
    "Errors (must fix):",
    ...report.errors.map(formatFinding),
  ];
  if (report.warnings.length > 0) {
    sections.push("", "Warnings (non-blocking):", ...report.warnings.map(formatFinding));
  }
  const dir = join(runDir, "feedback");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${stepId}-attempt-${nextAttempt}.md`);
  await writeFile(file, sections.join("\n") + "\n", "utf8");
}
