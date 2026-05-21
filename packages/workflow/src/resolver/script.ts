#!/usr/bin/env node
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { ArtifactStoreError } from "../errors.js";
import { resolveArtifactPath } from "../artifact-store.js";
import type {
  Citation,
  ClaimMatch,
  HopRecord,
  ResolverErrorKind,
  ResolverMatchKind,
  ResolverResponse,
} from "../types.js";
import { parseResolverResponse } from "./schema.js";

export interface ResolveArgs {
  ref: string;
  artifactsDir: string;
  workspacePath: string;
  stepId: string;
  claim?: string;
}

interface ParsedRef {
  file: string;
  section: string | null;
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "have",
  "has",
  "are",
  "was",
  "were",
  "but",
  "not",
  "you",
  "your",
  "use",
  "uses",
  "all",
]);

export function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function parseRef(ref: string): ParsedRef | null {
  if (typeof ref !== "string" || ref.trim().length === 0) return null;
  const trimmed = ref.trim();
  if (trimmed.includes("\n") || trimmed.includes("\r")) return null;
  const hashIdx = trimmed.indexOf("#");
  if (hashIdx === -1) {
    return { file: trimmed, section: null };
  }
  const file = trimmed.slice(0, hashIdx);
  const section = trimmed.slice(hashIdx + 1);
  if (file.length === 0) return null;
  if (section.length === 0) return null;
  return { file, section };
}

interface Section {
  heading: string;
  slug: string;
  level: number;
  startLine: number;
  endLine: number;
}

function extractSections(content: string): Section[] {
  const lines = content.split(/\r?\n/);
  const headings: { heading: string; slug: string; level: number; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i] ?? "");
    if (m) {
      const level = m[1].length;
      const text = m[2];
      headings.push({ heading: text, slug: slugify(text), level, line: i });
    }
  }
  const sections: Section[] = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    let end = lines.length;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= h.level) {
        end = headings[j].line;
        break;
      }
    }
    sections.push({
      heading: h.heading,
      slug: h.slug,
      level: h.level,
      startLine: h.line + 1,
      endLine: end,
    });
  }
  return sections;
}

const CITATION_RE =
  /(?:<!--|\/\/|#)\s*ref:\s*([^\s"]+)(?:\s+claim="((?:[^"\\]|\\.)*)")?\s*(?:-->)?/g;

function extractOutgoingRefs(content: string): Citation[] {
  const out: Citation[] = [];
  CITATION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CITATION_RE.exec(content)) !== null) {
    const refStr = m[1];
    const claim = m[2] ?? null;
    const parsed = parseRef(refStr);
    if (!parsed) continue;
    out.push({
      file: parsed.file,
      section: parsed.section,
      claim: claim === null ? null : claim.replace(/\\"/g, '"'),
    });
  }
  return out;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[^\w]+|[^\w]+$/g, "")
    .trim();
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
}

export function matchClaim(claim: string, sectionContent: string): ClaimMatch {
  if (sectionContent.includes(claim)) {
    return { found: true, match_kind: "exact_substring", confidence: 1.0 };
  }
  const nClaim = normalize(claim);
  const nContent = normalize(sectionContent);
  if (nClaim.length > 0 && nContent.includes(nClaim)) {
    return { found: true, match_kind: "normalized_substring", confidence: 0.85 };
  }
  const tokens = tokenize(claim);
  if (tokens.length === 0) {
    return { found: false, match_kind: null, confidence: 0.0 };
  }
  const lcContent = sectionContent.toLowerCase();
  let matched = 0;
  for (const t of tokens) {
    if (lcContent.includes(t)) matched++;
  }
  const confidence = matched / tokens.length;
  if (matched === tokens.length && confidence >= 0.5) {
    return { found: true, match_kind: "token_overlap", confidence };
  }
  return { found: false, match_kind: null, confidence: 0.0 };
}

function sectionBody(content: string, sec: Section): string {
  const lines = content.split(/\r?\n/);
  return lines.slice(sec.startLine, sec.endLine).join("\n");
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

export async function resolveCitation(
  args: ResolveArgs,
): Promise<ResolverResponse> {
  const { ref, artifactsDir, workspacePath, stepId, claim } = args;
  let response: ResolverResponse;
  let matchKind: ResolverMatchKind | null = null;

  const parsed = parseRef(ref);
  if (!parsed) {
    response = makeError(ref, "malformed_ref", `Could not parse ref string: ${ref}`);
  } else {
    let absPath: string;
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
        const claimMatch = claim ? matchClaim(claim, content) : null;
        if (claim && claimMatch && !claimMatch.found) {
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
        const sections = extractSections(content);
        const targetSlug = parsed.section.toLowerCase();
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
          const claimMatch = claim ? matchClaim(claim, body) : null;
          if (claim && claimMatch && !claimMatch.found) {
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
}

export function parseCliArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): CliArgs {
  const rest = argv.slice(2);
  if (rest.length === 0) {
    throw new Error("Usage: aow-ref <ref> [--claim <text>] [--artifacts-dir <path>] [--workspace-path <path>] [--step-id <id>]");
  }
  let ref: string | undefined;
  let claim: string | undefined;
  let artifactsDir: string | undefined;
  let workspacePath: string | undefined;
  let stepId: string | undefined;
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
