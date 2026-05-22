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

const CODE_FILE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
];

export function isCodeFile(path: string): boolean {
  const lower = path.toLowerCase();
  return CODE_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// Top-level declarations we want to expose as "sections" in source files.
// Patterns are line-anchored (^ with m flag is enforced via per-line scan).
const TOP_LEVEL_DECL_RES: RegExp[] = [
  /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[(<]/,
  /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/,
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/,
  /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/,
  /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[<=]/,
  /^(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)\b/,
];

// Class method declarations: indented lines inside a class body. We only fire
// while inside a `class { ... }` block tracked by a brace counter starting at
// the class declaration line.
const CLASS_METHOD_RE =
  /^\s+(?:(?:public|private|protected|static|async|readonly|override)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;

const CONTROL_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "throw",
  "do",
  "else",
  "constructor",
]);

function findTopLevelMatch(line: string): string | null {
  for (const re of TOP_LEVEL_DECL_RES) {
    const m = re.exec(line);
    if (m) return m[1];
  }
  return null;
}

export function extractCodeSections(content: string): Section[] {
  const lines = content.split(/\r?\n/);
  type Decl = { heading: string; slug: string; line: number };
  const decls: Decl[] = [];
  const seen = new Set<string>();

  let classDepth = 0;
  let braceDepth = 0;
  let classOpenDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";

    // Track top-level declarations (only when not inside any block).
    if (braceDepth === 0) {
      const name = findTopLevelMatch(raw);
      if (name && !seen.has(name)) {
        decls.push({ heading: name, slug: slugify(name), line: i });
        seen.add(name);
      }
    } else if (classDepth > 0) {
      // Inside a class body — capture method declarations.
      const mm = CLASS_METHOD_RE.exec(raw);
      if (mm) {
        const name = mm[1];
        if (!CONTROL_KEYWORDS.has(name) && !seen.has(name)) {
          decls.push({ heading: name, slug: slugify(name), line: i });
          seen.add(name);
        }
      }
    }

    // Detect class block entry on this line so we count its braces correctly.
    const enteringClass =
      braceDepth === 0 &&
      /^(?:export\s+)?(?:abstract\s+)?class\s+[A-Za-z_$][\w$]*/.test(raw);

    // Update brace depth using a string-and-comment aware scan.
    const delta = countBraceDelta(raw);
    const before = braceDepth;
    braceDepth += delta;
    if (braceDepth < 0) braceDepth = 0;

    if (enteringClass && braceDepth > before) {
      classDepth++;
      classOpenDepth = before; // depth we were at before entering
    } else if (classDepth > 0 && braceDepth <= classOpenDepth) {
      classDepth--;
    }
  }

  const sections: Section[] = [];
  for (let i = 0; i < decls.length; i++) {
    const d = decls[i];
    const end = i + 1 < decls.length ? decls[i + 1].line : lines.length;
    sections.push({
      heading: d.heading,
      slug: d.slug,
      level: 1,
      startLine: d.line,
      endLine: end,
    });
  }
  return sections;
}

function countBraceDelta(line: string): number {
  let depth = 0;
  let inString: '"' | "'" | "`" | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const next = line[i + 1];
    if (inLineComment) break;
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === inString) inString = null;
      continue;
    }
    if (c === "/" && next === "/") {
      inLineComment = true;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  return depth;
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
  const sectionTokens = tokenize(sectionContent);
  let matched = 0;
  for (const t of tokens) {
    if (lcContent.includes(t)) {
      matched++;
      continue;
    }
    if (sectionTokens.some((s) => s.length >= 4 && (s.startsWith(t) || t.startsWith(s)))) {
      matched++;
    }
  }
  const confidence = matched / tokens.length;
  if (confidence >= 0.5) {
    return { found: true, match_kind: "token_overlap", confidence };
  }
  return { found: false, match_kind: null, confidence: 0.0 };
}

export function sectionBody(content: string, sec: Section): string {
  const lines = content.split(/\r?\n/);
  return lines.slice(sec.startLine, sec.endLine).join("\n");
}
