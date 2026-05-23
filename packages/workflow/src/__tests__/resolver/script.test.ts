import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  matchClaim,
  parseCliArgs,
  parseRef,
  resolveCitation,
  slugify,
} from "../../resolver/script.js";
import { parseResolverResponse } from "../../resolver/schema.js";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");

function freshWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "aow-resolver-"));
}

const workspaces: string[] = [];
function ws(): string {
  const w = freshWorkspace();
  workspaces.push(w);
  return w;
}

afterEach(() => {
  // best-effort; not strictly necessary in tmp
});

describe("slugify + parseRef", () => {
  it("slugify GitHub-style", () => {
    expect(slugify("Auth Flow")).toBe("auth-flow");
    expect(slugify("Data Retention!")).toBe("data-retention");
    expect(slugify("  Mixed   Case  ")).toBe("mixed-case");
  });

  it("parseRef parses file-only", () => {
    expect(parseRef("design.md")).toEqual({ file: "design.md", section: null });
  });

  it("parseRef parses file#section", () => {
    expect(parseRef("design.md#auth-flow")).toEqual({
      file: "design.md",
      section: "auth-flow",
    });
  });

  it("parseRef rejects empty / dangling-hash", () => {
    expect(parseRef("")).toBeNull();
    expect(parseRef("#foo")).toBeNull();
    expect(parseRef("design.md#")).toBeNull();
  });
});

describe("matchClaim tiers", () => {
  const body =
    "Users log in with email + password. We never store passwords; we use a one-way bcrypt cost factor 12 hash.";

  it("exact_substring", () => {
    const m = matchClaim("bcrypt cost factor 12", body);
    expect(m.match_kind).toBe("exact_substring");
    expect(m.confidence).toBe(1.0);
  });

  it("normalized_substring", () => {
    const m = matchClaim("BCRYPT   COST   FACTOR  12", body);
    expect(m.match_kind).toBe("normalized_substring");
    expect(m.confidence).toBeCloseTo(0.85);
  });

  it("token_overlap", () => {
    const m = matchClaim("bcrypt hash passwords email", body);
    expect(m.match_kind).toBe("token_overlap");
    expect(m.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("no match (below_threshold sentinel — tokens exist, 0 overlap)", () => {
    const m = matchClaim("kubernetes orchestration helmcharts", body);
    expect(m.found).toBe(false);
    expect(m.match_kind).toBe("below_threshold");
  });
});

describe("resolveCitation — happy paths", () => {
  it("resolves section, returns body + outgoing_refs", async () => {
    const r = await resolveCitation({
      ref: "hld.md#service-boundaries",
      artifactsDir: FIXTURES,
      workspacePath: ws(),
      stepId: "t1",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.artifact_relative_path).toBe("hld.md");
    expect(r.section_heading).toBe("## Service Boundaries");
    expect(r.outgoing_refs).toHaveLength(1);
    expect(r.outgoing_refs[0]).toEqual({
      file: "design.md",
      section: "auth-flow",
      claim: "bcrypt cost factor 12",
    });
  });

  it("file-level ref returns whole file content", async () => {
    const r = await resolveCitation({
      ref: "design.md",
      artifactsDir: FIXTURES,
      workspacePath: ws(),
      stepId: "t2",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.section_heading).toBeNull();
    expect(r.section_content).toContain("Auth Flow");
    expect(r.section_content).toContain("Data Retention");
  });

  it("each match tier surfaces correct match_kind", async () => {
    const exact = await resolveCitation({
      ref: "design.md#auth-flow",
      artifactsDir: FIXTURES,
      workspacePath: ws(),
      stepId: "te",
      claim: "bcrypt cost factor 12",
    });
    expect(exact.ok).toBe(true);
    if (exact.ok)
      expect(exact.claim_match?.match_kind).toBe("exact_substring");

    const norm = await resolveCitation({
      ref: "design.md#auth-flow",
      artifactsDir: FIXTURES,
      workspacePath: ws(),
      stepId: "tn",
      claim: "BCRYPT   COST   FACTOR  12",
    });
    expect(norm.ok).toBe(true);
    if (norm.ok)
      expect(norm.claim_match?.match_kind).toBe("normalized_substring");

    const tok = await resolveCitation({
      ref: "design.md#auth-flow",
      artifactsDir: FIXTURES,
      workspacePath: ws(),
      stepId: "tt",
      claim: "passwords sessions expire hours",
    });
    expect(tok.ok).toBe(true);
    if (tok.ok) expect(tok.claim_match?.match_kind).toBe("token_overlap");
  });

  it("extracts outgoing refs from // ref: comments in code", async () => {
    const r = await resolveCitation({
      ref: "sample.ts",
      artifactsDir: FIXTURES,
      workspacePath: ws(),
      stepId: "code",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.outgoing_refs).toHaveLength(1);
    expect(r.outgoing_refs[0].file).toBe("hld.md");
  });
});

describe("resolveCitation — error kinds", () => {
  it("malformed_ref", async () => {
    const r = await resolveCitation({
      ref: "#bad",
      artifactsDir: FIXTURES,
      workspacePath: ws(),
      stepId: "m",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("malformed_ref");
  });

  it("file_not_found", async () => {
    const r = await resolveCitation({
      ref: "nope.md#x",
      artifactsDir: FIXTURES,
      workspacePath: ws(),
      stepId: "f",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("file_not_found");
  });

  it("section_not_found includes available_sections", async () => {
    const r = await resolveCitation({
      ref: "design.md#does-not-exist",
      artifactsDir: FIXTURES,
      workspacePath: ws(),
      stepId: "s",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("section_not_found");
      expect(r.available_sections).toContain("auth-flow");
    }
  });

  it("claim_unfaithful when low-overlap claim is rejected by LLM (stubbed)", async () => {
    process.env.AOW_LLM_CHECK_STUB = "unfaithful";
    try {
      const r = await resolveCitation({
        ref: "design.md#auth-flow",
        artifactsDir: FIXTURES,
        workspacePath: ws(),
        stepId: "cm",
        claim: "kubernetes helmcharts orchestration deployment",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("claim_unfaithful");
    } finally {
      delete process.env.AOW_LLM_CHECK_STUB;
    }
  });

  it("outside_artifacts_dir rejects ../escape", async () => {
    const r = await resolveCitation({
      ref: "../escape.md",
      artifactsDir: FIXTURES,
      workspacePath: ws(),
      stepId: "esc",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("outside_artifacts_dir");
  });
});

describe("hop log + warnings", () => {
  it("appends one JSON line per invocation with correct shape", async () => {
    const w = ws();
    await resolveCitation({
      ref: "design.md#auth-flow",
      artifactsDir: FIXTURES,
      workspacePath: w,
      stepId: "log-test",
    });
    const log = readFileSync(join(w, ".ao", "ref-hops.jsonl"), "utf8");
    const lines = log.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.step_id).toBe("log-test");
    expect(entry.ref).toBe("design.md#auth-flow");
    expect(entry.outcome).toBe("ok");
    expect(typeof entry.ts).toBe("string");
  });

  it("emits hop_depth_4 warning on the 5th hop for same step_id", async () => {
    const w = ws();
    for (let i = 0; i < 4; i++) {
      const r = await resolveCitation({
        ref: "design.md#auth-flow",
        artifactsDir: FIXTURES,
        workspacePath: w,
        stepId: "deep",
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.warnings).toBeUndefined();
    }
    const fifth = await resolveCitation({
      ref: "design.md#auth-flow",
      artifactsDir: FIXTURES,
      workspacePath: w,
      stepId: "deep",
    });
    expect(fifth.ok).toBe(true);
    if (fifth.ok) expect(fifth.warnings).toContain("hop_depth_4");
  });

  it("different step_id values do not trigger the warning past cumulative 4", async () => {
    const w = ws();
    for (let i = 0; i < 6; i++) {
      const r = await resolveCitation({
        ref: "design.md#auth-flow",
        artifactsDir: FIXTURES,
        workspacePath: w,
        stepId: `step-${i}`,
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.warnings).toBeUndefined();
    }
  });

  it("emitted JSON validates against the schema", async () => {
    const r = await resolveCitation({
      ref: "design.md#auth-flow",
      artifactsDir: FIXTURES,
      workspacePath: ws(),
      stepId: "schema-check",
      claim: "bcrypt cost factor 12",
    });
    expect(() => parseResolverResponse(r)).not.toThrow();
  });
});

describe("parseCliArgs", () => {
  it("parses ref + --claim + --artifacts-dir + --workspace-path + --step-id", () => {
    const args = parseCliArgs(
      ["node", "script.js", "a.md#x", "--claim", "c", "--artifacts-dir", "/a", "--workspace-path", "/w", "--step-id", "s1"],
      {},
      "/cwd",
    );
    expect(args).toEqual({
      ref: "a.md#x",
      claim: "c",
      artifactsDir: "/a",
      workspacePath: "/w",
      stepId: "s1",
      inputs: undefined,
    });
  });

  it("falls back to AOW_STEP_ID and cwd", () => {
    const args = parseCliArgs(
      ["node", "script.js", "a.md"],
      { AOW_STEP_ID: "envstep" },
      "/here",
    );
    expect(args.stepId).toBe("envstep");
    expect(args.artifactsDir).toBe("/here");
    expect(args.workspacePath).toBe("/here");
  });

  it("throws when step id missing", () => {
    expect(() => parseCliArgs(["node", "s.js", "a.md"], {}, "/x")).toThrow();
  });

  it("parses --inputs as JSON array of {name, path}", () => {
    const args = parseCliArgs(
      [
        "node", "s.js", "a.md",
        "--step-id", "s",
        "--inputs", JSON.stringify([{ name: "req", path: "/abs/requirements.md" }]),
      ],
      {}, "/cwd",
    );
    expect(args.inputs).toEqual([{ name: "req", path: "/abs/requirements.md" }]);
  });

  it("rejects malformed --inputs JSON", () => {
    expect(() => parseCliArgs(
      ["node", "s.js", "a.md", "--step-id", "s", "--inputs", "not-json"],
      {}, "/cwd",
    )).toThrow(/--inputs/);
  });
});

describe("resolveCitation — inputs map (Fix 1)", () => {
  it("resolves citation file via input.name match (absolute path)", async () => {
    const root = mkdtempSync(join(tmpdir(), "aow-inputs-"));
    const inputFile = join(root, "requirements.md");
    writeFileSync(inputFile, "# Reqs\n\n## Out of scope\nNothing here.\n", "utf8");
    const artifactsDir = join(root, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });

    const r = await resolveCitation({
      ref: "requirements.md#out-of-scope",
      artifactsDir,
      workspacePath: ws(),
      stepId: "t",
      inputs: [{ name: "requirements", path: inputFile }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.section_heading).toBe("## Out of scope");
    }
  });

  it("matches input by basename when name differs", async () => {
    const root = mkdtempSync(join(tmpdir(), "aow-inputs-"));
    const inputFile = join(root, "requirements.md");
    writeFileSync(inputFile, "# Reqs\n\n## Out of scope\nx\n", "utf8");
    const artifactsDir = join(root, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });

    // Input is named "req" but cite uses "requirements.md" — basename of the
    // input path matches the citation file.
    const r = await resolveCitation({
      ref: "requirements.md",
      artifactsDir,
      workspacePath: ws(),
      stepId: "t",
      inputs: [{ name: "req", path: inputFile }],
    });
    expect(r.ok).toBe(true);
  });

  it("falls back to filesystem when no matching input", async () => {
    // No inputs given; the existing FIXTURES design.md is reachable.
    const r = await resolveCitation({
      ref: "design.md#auth-flow",
      artifactsDir: FIXTURES,
      workspacePath: ws(),
      stepId: "t",
      inputs: [{ name: "other", path: "/nonexistent/path.md" }],
    });
    expect(r.ok).toBe(true);
  });
});

describe("resolveCitation — slug normalization (Fix 2)", () => {
  it("matches GitHub-style slug, literal heading, and underscore form", async () => {
    const root = mkdtempSync(join(tmpdir(), "aow-slug-"));
    const artifactsDir = join(root, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(
      join(artifactsDir, "doc.md"),
      "# Title\n\n## Out of scope\nbody\n\n## API: usage details\nb2\n",
      "utf8",
    );

    for (const frag of ["out-of-scope", "Out of scope", "out_of_scope", "OUT-OF-SCOPE"]) {
      const r = await resolveCitation({
        ref: `doc.md#${frag}`,
        artifactsDir,
        workspacePath: ws(),
        stepId: "s",
      });
      expect(r.ok, `fragment "${frag}" should resolve`).toBe(true);
    }

    const r2 = await resolveCitation({
      ref: "doc.md#api-usage-details",
      artifactsDir,
      workspacePath: ws(),
      stepId: "s2",
    });
    expect(r2.ok).toBe(true);
  });
});

describe("resolveCitation — code-symbol anchors (Phase 3.10)", () => {
  function writeArtifact(name: string, content: string): string {
    const root = mkdtempSync(join(tmpdir(), "aow-code-"));
    const artifactsDir = join(root, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, name), content, "utf8");
    return artifactsDir;
  }

  it("resolves `Shortener.ts#shorten` against an exported function", async () => {
    const artifactsDir = writeArtifact(
      "Shortener.ts",
      [
        "export function shorten(url: string): string {",
        '  return "abc1234";',
        "}",
        "",
      ].join("\n"),
    );
    const r = await resolveCitation({
      ref: "Shortener.ts#shorten",
      artifactsDir,
      workspacePath: ws(),
      stepId: "code-fn",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.section_content).toContain("export function shorten");
    }
  });

  it("resolves `HashRing.ts#addShard` against a class-method declaration", async () => {
    const artifactsDir = writeArtifact(
      "HashRing.ts",
      [
        "export class HashRing {",
        "  addShard(name: string): void {",
        "    // adds a shard",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const r = await resolveCitation({
      ref: "HashRing.ts#addShard",
      artifactsDir,
      workspacePath: ws(),
      stepId: "code-method",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.section_content).toContain("addShard");
    }
  });

  it("returns section_not_found with available symbols for a missing anchor", async () => {
    const artifactsDir = writeArtifact(
      "Shortener.ts",
      "export function shorten() { return 'x'; }\nexport function decode() { return 'y'; }\n",
    );
    const r = await resolveCitation({
      ref: "Shortener.ts#nonexistent",
      artifactsDir,
      workspacePath: ws(),
      stepId: "code-miss",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("section_not_found");
      expect(r.available_sections).toEqual(
        expect.arrayContaining(["shorten", "decode"]),
      );
    }
  });

  it("leaves the existing Markdown path intact", async () => {
    const r = await resolveCitation({
      ref: "design.md#auth-flow",
      artifactsDir: FIXTURES,
      workspacePath: ws(),
      stepId: "md-still-works",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.section_heading).toBe("## Auth Flow");
    }
  });

  it("matches a claim against text inside the function body", async () => {
    const artifactsDir = writeArtifact(
      "Shortener.ts",
      [
        "export function shorten(url: string): string {",
        "  // generates a 7-char base62 code",
        '  return "abc1234";',
        "}",
        "",
      ].join("\n"),
    );
    const r = await resolveCitation({
      ref: "Shortener.ts#shorten",
      artifactsDir,
      workspacePath: ws(),
      stepId: "code-claim",
      claim: "generates a 7-char base62 code",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.claim_match?.found).toBe(true);
    }
  });
});
