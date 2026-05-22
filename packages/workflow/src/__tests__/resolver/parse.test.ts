import { describe, expect, it } from "vitest";

import {
  extractCodeSections,
  isCodeFile,
  matchClaim,
} from "../../resolver/parse.js";

describe("isCodeFile", () => {
  it("recognizes the supported JS/TS extensions", () => {
    for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]) {
      expect(isCodeFile(`src/foo${ext}`)).toBe(true);
    }
  });

  it("rejects unsupported extensions", () => {
    expect(isCodeFile("README.md")).toBe(false);
    expect(isCodeFile("notes.txt")).toBe(false);
    expect(isCodeFile("script.py")).toBe(false);
    expect(isCodeFile("main.go")).toBe(false);
  });

  it("is case-insensitive on extension", () => {
    expect(isCodeFile("Foo.TS")).toBe(true);
  });
});

describe("extractCodeSections", () => {
  it("finds an exported function", () => {
    const src = `export function shorten(url: string): string {\n  return "abc";\n}\n`;
    const out = extractCodeSections(src);
    expect(out).toHaveLength(1);
    expect(out[0].heading).toBe("shorten");
    expect(out[0].slug).toBe("shorten");
    expect(out[0].startLine).toBe(0);
  });

  it("finds an exported class", () => {
    const src = `export class HashRing {\n  size = 0;\n}\n`;
    const out = extractCodeSections(src);
    expect(out.map((s) => s.slug)).toEqual(["hashring"]);
  });

  it("finds a class method via slug", () => {
    const src = [
      "export class HashRing {",
      "  shardForKey(key: string): number {",
      "    return 0;",
      "  }",
      "}",
      "",
    ].join("\n");
    const out = extractCodeSections(src);
    const slugs = out.map((s) => s.slug);
    expect(slugs).toContain("hashring");
    expect(slugs).toContain("shardforkey");
  });

  it("finds an exported const arrow function", () => {
    const src = `export const generateCode = (n: number) => "x";\n`;
    const out = extractCodeSections(src);
    expect(out).toHaveLength(1);
    expect(out[0].slug).toBe("generatecode");
  });

  it("returns empty array for an empty file", () => {
    expect(extractCodeSections("")).toEqual([]);
  });

  it("returns empty array for comments and imports only", () => {
    const src = [
      "// just a comment",
      "/* block comment */",
      'import { foo } from "./foo.js";',
      'import type { Bar } from "./bar.js";',
      "",
    ].join("\n");
    expect(extractCodeSections(src)).toEqual([]);
  });

  it("captures multiple top-level declarations in one file", () => {
    const src = [
      "export interface Options { n: number }",
      "export type Result = string;",
      "export const VERSION = 1;",
      "export function buildOne(): Result { return 'x'; }",
      "export class Builder {",
      "  build(): Result { return 'y'; }",
      "}",
      "export enum Kind { A, B }",
      "",
    ].join("\n");
    const slugs = extractCodeSections(src).map((s) => s.slug);
    expect(slugs).toEqual(
      expect.arrayContaining(["options", "result", "version", "buildone", "builder", "build", "kind"]),
    );
  });

  it("ignores control-flow keywords that look like method calls", () => {
    const src = [
      "export class Foo {",
      "  run() {",
      "    if (true) { return 1; }",
      "    for (const x of []) {}",
      "    while (false) {}",
      "  }",
      "}",
      "",
    ].join("\n");
    const slugs = extractCodeSections(src).map((s) => s.slug);
    expect(slugs).toContain("foo");
    expect(slugs).toContain("run");
    expect(slugs).not.toContain("if");
    expect(slugs).not.toContain("for");
    expect(slugs).not.toContain("while");
  });

  it("computes endLine as next declaration or EOF", () => {
    const src = [
      "export function a() {",
      "  return 1;",
      "}",
      "",
      "export function b() {",
      "  return 2;",
      "}",
      "",
    ].join("\n");
    const out = extractCodeSections(src);
    expect(out).toHaveLength(2);
    expect(out[0].endLine).toBe(out[1].startLine);
    expect(out[1].endLine).toBe(src.split("\n").length);
  });
});

describe("matchClaim — loose matching (Phase 3.11)", () => {
  it("verbatim claim still matches as exact_substring", () => {
    const section = "Orchestrates the write path: generate a random 7-char base62 code.";
    const claim = "generate a random 7-char base62 code";
    const m = matchClaim(claim, section);
    expect(m.match_kind).toBe("exact_substring");
    expect(m.confidence).toBe(1.0);
  });

  it("paraphrase passes with prefix match (generates → generate)", () => {
    const section = "Orchestrates the write path: generate a random 7-char base62 code.";
    const claim = "Shortener generates random 7-char base62 code";
    const m = matchClaim(claim, section);
    expect(m.found).toBe(true);
    expect(m.match_kind).toBe("token_overlap");
    expect(m.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("50%-threshold passes (3 of 5 tokens match)", () => {
    const section = "alpha beta gamma delta epsilon";
    const claim = "alpha beta gamma omicron upsilon";
    const m = matchClaim(claim, section);
    expect(m.found).toBe(true);
    expect(m.match_kind).toBe("token_overlap");
    expect(m.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("below-threshold fails (2 of 5 tokens match)", () => {
    const section = "alpha beta xxxxx yyyyy zzzzz";
    const claim = "alpha beta omicron upsilon lambda";
    const m = matchClaim(claim, section);
    expect(m.found).toBe(false);
    expect(m.match_kind).toBeNull();
  });

  it("prefix below 4 chars does not match (set vs setIfAbsent)", () => {
    // "set" is length 3 → filtered by tokenize; "up" is length 2 → filtered.
    // No tokens survive, so result is no-match.
    const section = "we call setIfAbsent on the cache";
    const claim = "set up";
    const m = matchClaim(claim, section);
    expect(m.found).toBe(false);
  });

  it("prefix is bidirectional (section 'route' vs claim 'routes')", () => {
    const section = "we route the key to the owning shard via hashring lookup";
    const claim = "routes lookup hashring shard";
    const m = matchClaim(claim, section);
    expect(m.found).toBe(true);
    expect(m.match_kind).toBe("token_overlap");
  });

  it("prefix is bidirectional (section 'routes' vs claim 'route')", () => {
    const section = "the shortener routes incoming keys through the ring lookup";
    const claim = "route lookup shortener incoming";
    const m = matchClaim(claim, section);
    expect(m.found).toBe(true);
    expect(m.match_kind).toBe("token_overlap");
  });

  it("totally invented claim fails", () => {
    const section =
      "HashRing distributes keys across shards using consistent hashing with virtual nodes.";
    const claim = "implements RAFT consensus protocol with paxos quorum voting";
    const m = matchClaim(claim, section);
    expect(m.found).toBe(false);
    expect(m.match_kind).toBeNull();
  });
});
