// Citation extraction + density checks. Pure functions, no I/O. Kept separate
// from citation-linter.ts so the main file stays under the per-file LOC cap.

import type { CitationFinding } from "../citation-linter.js";

export const MAX_CITATIONS_PER_SECTION = 3;
export const MAX_CITATION_DENSITY_MULTIPLIER = 3;

export interface ExtractedCitation {
  refString: string;
  file: string;
  section: string | null;
  claim: string | null;
  outputFile: string;
  lineNumber: number;
}

const HTML_RE =
  /<!--\s*ref:\s*([^#\s]+)#([^\s"]+)(?:\s+claim="([^"]*)")?\s*-->/g;
const LINE_RE =
  /(?:\/\/|#)\s*ref:\s*([^#\s]+)#([^\s"]+)(?:\s+claim="([^"]*)")?/g;

export function extractCitations(
  content: string,
  outputFile: string,
): ExtractedCitation[] {
  const found: ExtractedCitation[] = [];
  const seen = new Set<string>();
  const lineStarts: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  const lineOf = (idx: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  for (const re of [HTML_RE, LINE_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const file = m[1];
      const section = m[2];
      const claim = m[3] ?? null;
      const refString = `${file}#${section}`;
      const dedupKey = `${m.index}:${refString}:${claim ?? ""}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      found.push({
        refString,
        file,
        section,
        claim,
        outputFile,
        lineNumber: lineOf(m.index),
      });
    }
  }
  return found.sort((a, b) => a.lineNumber - b.lineNumber);
}

export function densityChecks(
  citations: ExtractedCitation[],
  content: string,
  relOutput: string,
  trackedInputCount: number,
): CitationFinding[] {
  const findings: CitationFinding[] = [];
  if (trackedInputCount >= 2 && citations.length === 0) {
    findings.push({
      kind: "warning",
      code: "no_citations_but_inputs",
      outputFile: relOutput,
      message: `Output has 0 citations but step declared ${trackedInputCount} tracked inputs`,
    });
  }

  const lines = content.split(/\r?\n/);
  interface H3Block {
    heading: string;
    start: number;
    end: number;
  }
  const blocks: H3Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^###\s+/.test(line)) {
      if (blocks.length > 0) blocks[blocks.length - 1].end = i;
      blocks.push({
        heading: line.replace(/^###\s+/, "").trim(),
        start: i + 1,
        end: lines.length,
      });
    }
  }
  const majorSections = blocks.length;
  if (
    majorSections > 0 &&
    citations.length > MAX_CITATION_DENSITY_MULTIPLIER * majorSections
  ) {
    findings.push({
      kind: "warning",
      code: "over_citation",
      outputFile: relOutput,
      message: `Output has ${citations.length} citations across ${majorSections} major sections`,
      detail: `> ${MAX_CITATION_DENSITY_MULTIPLIER}x density limit`,
    });
  }

  for (const block of blocks) {
    const inBlock = citations.filter(
      (c) => c.lineNumber > block.start && c.lineNumber <= block.end + 1,
    );
    if (inBlock.length > MAX_CITATIONS_PER_SECTION) {
      findings.push({
        kind: "warning",
        code: "section_over_cited",
        outputFile: relOutput,
        message: `Section has ${inBlock.length} citations (limit ${MAX_CITATIONS_PER_SECTION})`,
        detail: `section: ${block.heading}`,
      });
    }
  }
  return findings;
}
