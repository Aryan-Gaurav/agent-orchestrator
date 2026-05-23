// Phase 3.12 — third-tier claim verifier.
//
// When matchClaim returns the `below_threshold` sentinel (token overlap
// in [0, 0.3) with non-empty tokens), resolveCitation shells out to the
// local `claude` CLI to decide whether the claim is a faithful paraphrase
// or hallucination. This module owns that shell-out.
//
// Hard constraints (see docs/workflow-engine.md §17):
//   - No new runtime dependencies (uses node:child_process.execFile only).
//   - No API key handling (relies on `claude` CLI's own auth).
//   - No caching (each call shells fresh).
//   - Never throws on tooling failure — returns null so the caller can
//     decide policy (current policy: permissive pass + warning).
//
// Test seam: when AOW_LLM_CHECK_STUB is set, the function returns canned
// data instead of shelling out. This is the ONLY way to mock the LLM check
// from inside the spawned resolver subprocess (vi.mock cannot reach across
// the child_process boundary). Recognized values:
//   "faithful"   → { faithful: true,  reason: "stubbed: faithful" }
//   "unfaithful" → { faithful: false, reason: "stubbed: unfaithful" }
//   "null"       → null  (simulates `claude` not on PATH / error)
// Any other value is treated as "null".

import { execFile } from "node:child_process";

import type { ClaimMatch } from "../types.js";

export interface LlmVerdict {
  faithful: boolean;
  reason: string;
}

export interface CheckClaimArgs {
  sectionContent: string;
  claim: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_SECTION_CHARS = 4000;
const MAX_BUFFER_BYTES = 1_000_000;
const TRUNCATION_SUFFIX = "\n... [truncated]";

export function buildPrompt(sectionContent: string, claim: string): string {
  let section = sectionContent;
  if (section.length > MAX_SECTION_CHARS) {
    section = section.slice(0, MAX_SECTION_CHARS) + TRUNCATION_SUFFIX;
  }
  return [
    'You verify that a "claim" comment in code accurately describes content present in a cited section. Reply ONLY with a single JSON object, no prose, no markdown.',
    "",
    'Schema: {"faithful": <boolean>, "reason": "<short explanation>"}',
    "",
    "Rules:",
    '- "faithful": true means the claim describes content the section actually contains. Paraphrase is fine. Synonyms are fine.',
    '- "faithful": false means the claim states something the section does NOT support, contradicts, or invents from thin air.',
    "- When you are uncertain, answer faithful=false. Be strict — false positives (passing a bad citation) are worse than false negatives (rejecting a paraphrase the author will rewrite).",
    "",
    "Examples:",
    "",
    "SECTION:",
    "function addShard(id) {",
    '  if (this.shardIds.has(id)) throw new Error("duplicate");',
    "  this.shardIds.add(id);",
    "}",
    'CLAIM: "addShard throws on duplicate shard id"',
    'RESPONSE: {"faithful": true, "reason": "section throws on duplicate"}',
    "",
    "SECTION:",
    "function lookup(key) {",
    "  return this.ring[hash(key) % this.ring.length].shardId;",
    "}",
    'CLAIM: "lookup uses consistent hashing with virtual nodes for even distribution"',
    'RESPONSE: {"faithful": false, "reason": "section uses modulo, not consistent hashing; no vnodes here"}',
    "",
    "Now evaluate:",
    "",
    "SECTION:",
    section,
    "",
    `CLAIM: ${claim}`,
    "",
    "RESPONSE:",
  ].join("\n");
}

function stubVerdict(): LlmVerdict | null {
  const v = process.env.AOW_LLM_CHECK_STUB;
  if (v === "faithful") {
    return { faithful: true, reason: "stubbed: faithful" };
  }
  if (v === "unfaithful") {
    return { faithful: false, reason: "stubbed: unfaithful" };
  }
  return null;
}

function parseVerdict(raw: unknown): LlmVerdict | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as { faithful?: unknown; reason?: unknown };
  if (typeof obj.faithful !== "boolean") return null;
  const reason = typeof obj.reason === "string" ? obj.reason : "";
  return { faithful: obj.faithful, reason };
}

function execClaude(
  prompt: string,
  timeoutMs: number,
): Promise<{ stdout: string } | null> {
  return new Promise((resolve) => {
    execFile(
      "claude",
      ["-p", "--output-format", "json", prompt],
      {
        timeout: timeoutMs,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
      },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const s =
          typeof stdout === "string" ? stdout : Buffer.from(stdout).toString("utf8");
        resolve({ stdout: s });
      },
    );
  });
}

export async function checkClaimWithClaude(
  args: CheckClaimArgs,
): Promise<LlmVerdict | null> {
  if (process.env.AOW_LLM_CHECK_STUB !== undefined) {
    return stubVerdict();
  }
  const prompt = buildPrompt(args.sectionContent, args.claim);
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const result = await execClaude(prompt, timeoutMs);
  if (result === null) return null;
  let outer: unknown;
  try {
    outer = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (typeof outer !== "object" || outer === null) return null;
  const inner = (outer as { result?: unknown }).result;
  if (typeof inner !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(inner);
  } catch {
    return null;
  }
  return parseVerdict(parsed);
}

export interface LlmResolution {
  /** When set, the caller must abort the success path and emit this error. */
  unfaithful?: { reason: string };
  /** When set, replaces the claim_match on the success response. */
  replacement?: ClaimMatch;
}

/**
 * When matchClaim returns the `below_threshold` sentinel, shell out to the
 * local `claude` CLI for a faithfulness verdict. Any other match_kind (or
 * `null` match) passes through unchanged.
 */
export async function resolveLowConfidence(
  claimMatch: ClaimMatch | null,
  body: string,
  claim: string,
): Promise<LlmResolution> {
  if (!claimMatch || claimMatch.match_kind !== "below_threshold") {
    return {};
  }
  const verdict = await checkClaimWithClaude({
    sectionContent: body,
    claim,
  });
  if (verdict === null) {
    return {
      replacement: {
        found: true,
        match_kind: "llm_unavailable",
        confidence: claimMatch.confidence,
      },
    };
  }
  if (verdict.faithful) {
    return {
      replacement: {
        found: true,
        match_kind: "llm_verified",
        confidence: 0.5,
        reason: verdict.reason,
      },
    };
  }
  return { unfaithful: { reason: verdict.reason } };
}
