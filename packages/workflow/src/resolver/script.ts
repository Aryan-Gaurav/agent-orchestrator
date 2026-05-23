#!/usr/bin/env node
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, resolve as resolvePath } from "node:path";

import { ArtifactStoreError } from "../errors.js";
import { resolveArtifactPath } from "../artifact-store.js";
import type {
  HopRecord,
  ResolverErrorKind,
  ResolverMatchKind,
  ResolverResponse,
} from "../types.js";
import {
  extractCodeSections,
  extractOutgoingRefs,
  extractSections,
  isCodeFile,
  matchClaim,
  parseRef,
  sectionBody,
  slugify,
} from "./parse.js";
import { resolveLowConfidence } from "./llm-check.js";
import { parseResolverResponse } from "./schema.js";

// Re-export for callers that imported them from script.ts.
export { matchClaim, parseRef, slugify } from "./parse.js";

export interface ResolverInput {
  /** Logical name as declared in the step's `inputs:` map (or workflow inputs). */
  name: string;
  /** Absolute path on disk that `name` aliases. */
  path: string;
}

export interface ResolveArgs {
  ref: string;
  artifactsDir: string;
  workspacePath: string;
  stepId: string;
  claim?: string;
  /** Step/workflow inputs that resolve by name or basename — see §17. */
  inputs?: ResolverInput[];
}

function isoNow(): string {
  return new Date().toISOString();
}

function appendHop(
  workspacePath: string,
  record: HopRecord,
): number {
  const dir = `${workspacePath}/.ao`;
  const file = `${dir}/ref-hops.jsonl`;
  mkdirSync(dir, { recursive: true });
  appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
  const content = readFileSync(file, "utf8");
  let count = 0;
  for (const line of content.split("\n")) {
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as Partial<HopRecord>;
      if (parsed.step_id === record.step_id) count++;
    } catch {
      // skip malformed lines
    }
  }
  return count;
}

function makeError(
  ref: string,
  error: ResolverErrorKind,
  message: string,
  available_sections?: string[],
): ResolverResponse {
  const out: ResolverResponse = {
    ok: false,
    ref,
    error,
    message,
    ...(available_sections ? { available_sections } : {}),
  };
  return out;
}

function resolveInputAlias(
  inputs: ResolverInput[] | undefined,
  file: string,
): string | null {
  if (!inputs || inputs.length === 0) return null;
  const fileBase = basename(file);
  for (const input of inputs) {
    if (input.name === file || input.name === fileBase) {
      return isAbsolute(input.path) ? input.path : resolvePath(input.path);
    }
    if (basename(input.path) === file || basename(input.path) === fileBase) {
      return isAbsolute(input.path) ? input.path : resolvePath(input.path);
    }
  }
  return null;
}

export async function resolveCitation(
  args: ResolveArgs,
): Promise<ResolverResponse> {
  const { ref, artifactsDir, workspacePath, stepId, claim, inputs } = args;
  let response: ResolverResponse;
  let matchKind: ResolverMatchKind | null = null;

  const parsed = parseRef(ref);
  if (!parsed) {
    response = makeError(ref, "malformed_ref", `Could not parse ref string: ${ref}`);
  } else {
    let absPath: string;
    const inputAlias = resolveInputAlias(inputs, parsed.file);
    if (inputAlias !== null) {
      absPath = inputAlias;
    } else {
      try {
        absPath = resolveArtifactPath(artifactsDir, parsed.file);
      } catch (err) {
        if (err instanceof ArtifactStoreError) {
          response = makeError(
            ref,
            "outside_artifacts_dir",
            `Path "${parsed.file}" escapes or is invalid relative to artifacts_dir: ${err.message}`,
          );
        } else {
          throw err;
        }
        const count = appendHop(workspacePath, {
          ts: isoNow(),
          step_id: stepId,
          ref,
          outcome: "error",
          match_kind: null,
        });
        void count;
        return response;
      }
    }

    if (!existsSync(absPath)) {
      response = makeError(ref, "file_not_found", `File not found: ${parsed.file}`);
    } else {
      let content: string;
      try {
        content = readFileSync(absPath, "utf8");
      } catch (err) {
        response = makeError(
          ref,
          "file_not_found",
          `Failed to read file ${parsed.file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        const count = appendHop(workspacePath, {
          ts: isoNow(),
          step_id: stepId,
          ref,
          outcome: "error",
          match_kind: null,
        });
        void count;
        return response;
      }

      if (parsed.section === null) {
        let claimMatch = claim ? matchClaim(claim, content) : null;
        let unfaithful: { reason: string } | null = null;
        if (claim && claimMatch?.match_kind === "below_threshold") {
          const r = await resolveLowConfidence(claimMatch, content, claim);
          if (r.unfaithful) {
            unfaithful = r.unfaithful;
          } else if (r.replacement) {
            claimMatch = r.replacement;
          }
        }
        if (unfaithful) {
          response = makeError(
            ref,
            "claim_unfaithful",
            `Claim contradicts or invents content not in ${parsed.file}: ${unfaithful.reason}`,
          );
        } else if (claim && claimMatch && !claimMatch.found) {
          response = makeError(
            ref,
            "claim_mismatch",
            `Claim did not match file content for ${parsed.file}`,
          );
        } else {
          matchKind = claimMatch?.match_kind ?? null;
          response = {
            ok: true,
            ref,
            artifact_relative_path: parsed.file,
            section_heading: null,
            section_content: content,
            outgoing_refs: extractOutgoingRefs(content),
            claim_match: claimMatch,
          };
        }
      } else {
        const sections = isCodeFile(parsed.file)
          ? extractCodeSections(content)
          : extractSections(content);
        const targetSlug = slugify(parsed.section.replace(/_/g, " "));
        const section = sections.find((s) => s.slug === targetSlug);
        if (!section) {
          response = makeError(
            ref,
            "section_not_found",
            `Section "${parsed.section}" not found in ${parsed.file}`,
            sections.map((s) => s.slug),
          );
        } else {
          const body = sectionBody(content, section);
          let claimMatch = claim ? matchClaim(claim, body) : null;
          let unfaithful: { reason: string } | null = null;
          if (claim && claimMatch?.match_kind === "below_threshold") {
            const r = await resolveLowConfidence(claimMatch, body, claim);
            if (r.unfaithful) {
              unfaithful = r.unfaithful;
            } else if (r.replacement) {
              claimMatch = r.replacement;
            }
          }
          if (unfaithful) {
            response = makeError(
              ref,
              "claim_unfaithful",
              `Claim contradicts or invents content not in section "${parsed.section}" of ${parsed.file}: ${unfaithful.reason}`,
            );
          } else if (claim && claimMatch && !claimMatch.found) {
            response = makeError(
              ref,
              "claim_mismatch",
              `Claim did not match section "${parsed.section}" in ${parsed.file}`,
            );
          } else {
            matchKind = claimMatch?.match_kind ?? null;
            response = {
              ok: true,
              ref,
              artifact_relative_path: parsed.file,
              section_heading: "#".repeat(section.level) + " " + section.heading,
              section_content: body,
              outgoing_refs: extractOutgoingRefs(body),
              claim_match: claimMatch,
            };
          }
        }
      }
    }
  }

  const outcome: "ok" | "error" = response.ok ? "ok" : "error";
  const count = appendHop(workspacePath, {
    ts: isoNow(),
    step_id: stepId,
    ref,
    outcome,
    match_kind: outcome === "ok" ? matchKind : null,
  });

  if (response.ok && count > 4) {
    response = { ...response, warnings: [...(response.warnings ?? []), "hop_depth_4"] };
  }

  return response;
}

interface CliArgs {
  ref: string;
  claim?: string;
  artifactsDir: string;
  workspacePath: string;
  stepId: string;
  inputs?: ResolverInput[];
}

function parseInputsJson(raw: string): ResolverInput[] {
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `--inputs must be a JSON array: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(parsedValue)) {
    throw new Error("--inputs must be a JSON array of {name, path} objects");
  }
  const out: ResolverInput[] = [];
  for (const item of parsedValue) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as { name?: unknown }).name !== "string" ||
      typeof (item as { path?: unknown }).path !== "string"
    ) {
      throw new Error("--inputs entries must be objects with string name and path");
    }
    const { name, path } = item as { name: string; path: string };
    if (name.length === 0 || path.length === 0) {
      throw new Error("--inputs entries must have non-empty name and path");
    }
    out.push({ name, path });
  }
  return out;
}

export function parseCliArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): CliArgs {
  const rest = argv.slice(2);
  if (rest.length === 0) {
    throw new Error("Usage: aow-ref <ref> [--claim <text>] [--artifacts-dir <path>] [--workspace-path <path>] [--step-id <id>] [--inputs <json>]");
  }
  let ref: string | undefined;
  let claim: string | undefined;
  let artifactsDir: string | undefined;
  let workspacePath: string | undefined;
  let stepId: string | undefined;
  let inputs: ResolverInput[] | undefined;
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === "--claim") {
      claim = rest[++i];
    } else if (tok === "--artifacts-dir") {
      artifactsDir = rest[++i];
    } else if (tok === "--workspace-path") {
      workspacePath = rest[++i];
    } else if (tok === "--step-id") {
      stepId = rest[++i];
    } else if (tok === "--inputs") {
      inputs = parseInputsJson(rest[++i] ?? "");
    } else if (ref === undefined) {
      ref = tok;
    } else {
      throw new Error(`Unexpected argument: ${tok}`);
    }
  }
  if (ref === undefined) throw new Error("Missing ref argument");
  const finalStepId = stepId ?? env.AOW_STEP_ID;
  if (!finalStepId) {
    throw new Error("--step-id is required (or set AOW_STEP_ID env var)");
  }
  return {
    ref,
    claim,
    artifactsDir: artifactsDir ?? cwd,
    workspacePath: workspacePath ?? cwd,
    stepId: finalStepId,
    inputs,
  };
}

async function main(): Promise<void> {
  let parsed: CliArgs;
  try {
    parsed = parseCliArgs(process.argv, process.env, process.cwd());
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
    return;
  }
  try {
    mkdirSync(dirname(`${parsed.workspacePath}/.ao/x`), { recursive: true });
  } catch {
    // best-effort
  }
  const response = await resolveCitation(parsed);
  const validated = parseResolverResponse(response);
  process.stdout.write(JSON.stringify(validated) + "\n");
  process.exit(validated.ok ? 0 : 1);
}

const invokedDirect = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return import.meta.url === `file://${entry}` || import.meta.url.endsWith(entry);
  } catch {
    return false;
  }
})();

if (invokedDirect) {
  void main();
}
