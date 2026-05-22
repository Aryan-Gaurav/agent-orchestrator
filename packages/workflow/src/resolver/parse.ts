// Pure helpers for resolver/script.ts. Kept separate so script.ts stays under
// the per-file LOC cap.

import type { Citation, ClaimMatch } from "../types.js";

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "have", "has",
  "are", "was", "were", "but", "not", "you", "your", "use", "uses", "all",
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

export interface ParsedRef {
  file: string;
  section: string | null;
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

export interface Section {
  heading: string;
  slug: string;
  level: number;
  startLine: number;
  endLine: number;
}

export function extractSections(content: string): Section[] {
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

export function extractOutgoingRefs(content: string): Citation[] {
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

export function sectionBody(content: string, sec: Section): string {
  const lines = content.split(/\r?\n/);
  return lines.slice(sec.startLine, sec.endLine).join("\n");
}
