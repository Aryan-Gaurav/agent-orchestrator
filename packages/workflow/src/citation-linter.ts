// Post-step citation linter. Runs after agent outputs are verified and before
// the step is marked completed. See docs/workflow-engine.md §17.2.
// Errors reject the step (feedback to agent). Warnings attach but allow pass.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";

import { resolveArtifactPath } from "./artifact-store.js";
import { ArtifactStoreError } from "./errors.js";
import { parseResolverResponse } from "./resolver/schema.js";
import type { ResolverResponse } from "./types.js";
import {
  densityChecks,
  extractCitations,
  type ExtractedCitation,
} from "./citation-linter/extract.js";

const execFileP = promisify(execFile);

export const RESOLVER_TIMEOUT_MS = 15_000;
export const HOP_DEPTH_LIMIT = 4;
export const CLAIM_LOW_CONFIDENCE_THRESHOLD = 0.7;
export {
  MAX_CITATIONS_PER_SECTION,
  MAX_CITATION_DENSITY_MULTIPLIER,
} from "./citation-linter/extract.js";

export type CitationFindingCode =
  | "malformed_ref"
  | "file_not_found"
  | "section_not_found"
  | "ambiguous_section"
  | "outside_artifacts_dir"
  | "claim_mismatch"
  | "claim_unfaithful"
  | "claim_low_confidence"
  | "missing_claim"
  | "no_citations_but_inputs"
  | "over_citation"
  | "section_over_cited"
  | "hop_depth_exceeded";

export interface CitationFinding {
  kind: "error" | "warning";
  code: CitationFindingCode;
  outputFile: string;
  ref?: string;
  claim?: string;
  message: string;
  detail?: string;
}

export interface LintInputAlias {
  /** Logical name used in citation paths (often equals basename). */
  name: string;
  /** Absolute path on disk that `name` aliases. */
  path: string;
}

export interface LintInputs {
  artifactsDir: string;
  workspacePath: string;
  stepId: string;
  outputFiles: string[];
  trackedInputCount: number;
  resolverScriptPath: string;
  /** Optional override for the per-subprocess timeout (default 15s). */
  resolverTimeoutMs?: number;
  /**
   * Step + workflow inputs. The resolver matches a citation's file path
   * against these by name OR basename before falling back to the artifacts
   * directory. See docs/workflow-engine.md §17.
   */
  inputs?: LintInputAlias[];
}

export interface LintReport {
  errors: CitationFinding[];
  warnings: CitationFinding[];
}

async function invokeResolver(
  input: LintInputs,
  refString: string,
  claim?: string,
): Promise<ResolverResponse | { timeout: true }> {
  const args = [
    input.resolverScriptPath,
    refString,
    "--artifacts-dir",
    input.artifactsDir,
    "--workspace-path",
    input.workspacePath,
    "--step-id",
    input.stepId,
  ];
  if (input.inputs && input.inputs.length > 0) {
    args.push("--inputs", JSON.stringify(input.inputs));
  }
  if (claim !== undefined) {
    args.push("--claim", claim);
  }
  try {
    const { stdout } = await execFileP(process.execPath, args, {
      timeout: input.resolverTimeoutMs ?? RESOLVER_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    return parseResolverResponse(JSON.parse(stdout));
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: string;
      stdout?: string;
      code?: string | number;
    };
    if (e.killed === true || e.signal === "SIGTERM" || e.code === "ETIMEDOUT") {
      return { timeout: true };
    }
    if (typeof e.stdout === "string" && e.stdout.length > 0) {
      try {
        return parseResolverResponse(JSON.parse(e.stdout));
      } catch {
        // fall through and rethrow
      }
    }
    throw err;
  }
}

async function lintCitation(
  input: LintInputs,
  cite: ExtractedCitation,
  relOutput: string,
): Promise<CitationFinding[]> {
  const findings: CitationFinding[] = [];
  try {
    resolveArtifactPath(input.artifactsDir, cite.file);
  } catch (err) {
    if (err instanceof ArtifactStoreError) {
      findings.push({
        kind: "error",
        code: "outside_artifacts_dir",
        outputFile: relOutput,
        ref: cite.refString,
        claim: cite.claim ?? undefined,
        message: `Citation path "${cite.file}" escapes artifacts directory`,
        detail: err.message,
      });
      return findings;
    }
    throw err;
  }

  const existResp = await invokeResolver(input, cite.refString);
  if ("timeout" in existResp) {
    findings.push({
      kind: "error",
      code: "file_not_found",
      outputFile: relOutput,
      ref: cite.refString,
      claim: cite.claim ?? undefined,
      message: `Resolver timed out checking ${cite.refString}`,
      detail: "resolver timeout",
    });
    return findings;
  }
  if (!existResp.ok) {
    const code = existResp.error;
    if (
      code === "file_not_found" ||
      code === "section_not_found" ||
      code === "ambiguous_section" ||
      code === "malformed_ref" ||
      code === "outside_artifacts_dir"
    ) {
      findings.push({
        kind: "error",
        code,
        outputFile: relOutput,
        ref: cite.refString,
        claim: cite.claim ?? undefined,
        message: existResp.message,
        detail:
          (code === "section_not_found" || code === "ambiguous_section") &&
          existResp.available_sections
            ? `available: ${existResp.available_sections.join(", ")}`
            : undefined,
      });
      return findings;
    }
  }

  if (cite.claim === null) {
    findings.push({
      kind: "warning",
      code: "missing_claim",
      outputFile: relOutput,
      ref: cite.refString,
      message: `Citation has no claim="..." attribute`,
    });
    return findings;
  }

  const claimResp = await invokeResolver(input, cite.refString, cite.claim);
  if ("timeout" in claimResp) {
    findings.push({
      kind: "error",
      code: "file_not_found",
      outputFile: relOutput,
      ref: cite.refString,
      claim: cite.claim,
      message: `Resolver timed out checking claim for ${cite.refString}`,
      detail: "resolver timeout",
    });
    return findings;
  }
  if (!claimResp.ok) {
    if (claimResp.error === "claim_mismatch") {
      findings.push({
        kind: "error",
        code: "claim_mismatch",
        outputFile: relOutput,
        ref: cite.refString,
        claim: cite.claim,
        message: claimResp.message,
      });
    } else if (claimResp.error === "claim_unfaithful") {
      findings.push({
        kind: "error",
        code: "claim_unfaithful",
        outputFile: relOutput,
        ref: cite.refString,
        claim: cite.claim,
        message: claimResp.message,
      });
    }
    return findings;
  }
  const match = claimResp.claim_match;
  if (match && match.found && match.match_kind === "token_overlap") {
    findings.push({
      kind: "warning",
      code: "claim_low_confidence",
      outputFile: relOutput,
      ref: cite.refString,
      claim: cite.claim,
      message: `Claim matched via token_overlap with confidence ${match.confidence.toFixed(2)}`,
      detail:
        match.confidence < CLAIM_LOW_CONFIDENCE_THRESHOLD
          ? `confidence < ${CLAIM_LOW_CONFIDENCE_THRESHOLD} (review recommended)`
          : `confidence >= ${CLAIM_LOW_CONFIDENCE_THRESHOLD}`,
    });
  } else if (match && match.found && match.match_kind === "llm_unavailable") {
    findings.push({
      kind: "warning",
      code: "claim_low_confidence",
      outputFile: relOutput,
      ref: cite.refString,
      claim: cite.claim,
      message: `Claim has very low token overlap (${match.confidence.toFixed(2)}) and the LLM checker was unavailable — passed under low confidence`,
      detail: "claude CLI unreachable; review recommended",
    });
  }
  // match_kind === "llm_verified" → clean pass, no finding.
  return findings;
}

async function hopDepthCheck(input: LintInputs): Promise<CitationFinding[]> {
  const hopFile = join(input.workspacePath, ".ao", "ref-hops.jsonl");
  if (!existsSync(hopFile)) return [];
  let raw: string;
  try {
    raw = await readFile(hopFile, "utf8");
  } catch {
    return [];
  }
  let count = 0;
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as { step_id?: unknown };
      if (parsed.step_id === input.stepId) count++;
    } catch {
      // ignore malformed lines
    }
  }
  if (count > HOP_DEPTH_LIMIT) {
    return [
      {
        kind: "warning",
        code: "hop_depth_exceeded",
        outputFile: "(step)",
        message: `Step has ${count} hops in ref-hops.jsonl (limit ${HOP_DEPTH_LIMIT})`,
      },
    ];
  }
  return [];
}

function toRelative(input: LintInputs, abs: string): string {
  const r = relative(input.artifactsDir, abs);
  return r.length === 0 ? abs : r;
}

export async function lintStepCitations(
  input: LintInputs,
): Promise<LintReport> {
  const all: CitationFinding[] = [];

  const perOutput = await Promise.all(
    input.outputFiles.map(async (abs) => {
      const relOutput = toRelative(input, abs);
      let content: string;
      try {
        content = await readFile(abs, "utf8");
      } catch {
        return [] as CitationFinding[];
      }
      const citations = extractCitations(content, abs);
      const out: CitationFinding[] = [];
      for (const cite of citations) {
        out.push(...(await lintCitation(input, cite, relOutput)));
      }
      out.push(
        ...densityChecks(citations, content, relOutput, input.trackedInputCount),
      );
      return out;
    }),
  );
  for (const arr of perOutput) all.push(...arr);
  all.push(...(await hopDepthCheck(input)));

  return {
    errors: all.filter((f) => f.kind === "error"),
    warnings: all.filter((f) => f.kind === "warning"),
  };
}
