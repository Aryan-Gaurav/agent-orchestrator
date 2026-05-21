import { describe, expect, it } from "vitest";

import { ResolverError } from "../../errors.js";
import {
  parseResolverResponse,
  resolverResponseSchema,
} from "../../resolver/schema.js";

describe("resolver schema", () => {
  it("accepts ok=true with claim_match", () => {
    const r = resolverResponseSchema.parse({
      ok: true,
      ref: "design.md#auth-flow",
      artifact_relative_path: "design.md",
      section_heading: "## Auth Flow",
      section_content: "body",
      outgoing_refs: [],
      claim_match: { found: true, match_kind: "exact_substring", confidence: 1.0 },
    });
    expect(r.ok).toBe(true);
  });

  it("accepts ok=true with no claim (claim_match=null)", () => {
    const r = resolverResponseSchema.parse({
      ok: true,
      ref: "design.md#auth-flow",
      artifact_relative_path: "design.md",
      section_heading: "## Auth Flow",
      section_content: "body",
      outgoing_refs: [{ file: "x.md", section: "y", claim: "z" }],
      claim_match: null,
    });
    expect(r.ok).toBe(true);
  });

  it("accepts ok=true with warnings", () => {
    const r = resolverResponseSchema.parse({
      ok: true,
      ref: "design.md",
      artifact_relative_path: "design.md",
      section_heading: null,
      section_content: "body",
      outgoing_refs: [],
      claim_match: null,
      warnings: ["hop_depth_4"],
    });
    expect(r.ok).toBe(true);
  });

  it("accepts file_not_found error", () => {
    const r = resolverResponseSchema.parse({
      ok: false,
      ref: "missing.md",
      error: "file_not_found",
      message: "no",
    });
    expect(r.ok).toBe(false);
  });

  it("accepts section_not_found with available_sections", () => {
    const r = resolverResponseSchema.parse({
      ok: false,
      ref: "design.md#nope",
      error: "section_not_found",
      message: "no",
      available_sections: ["auth-flow", "data-retention"],
    });
    expect(r.ok).toBe(false);
  });

  it("accepts each remaining error kind", () => {
    for (const error of [
      "claim_mismatch",
      "malformed_ref",
      "outside_artifacts_dir",
    ] as const) {
      const r = resolverResponseSchema.parse({
        ok: false,
        ref: "x",
        error,
        message: "m",
      });
      expect(r.ok).toBe(false);
    }
  });

  it("parseResolverResponse throws on malformed input", () => {
    expect(() => parseResolverResponse({ ok: "maybe" })).toThrow(ResolverError);
    expect(() => parseResolverResponse({ ok: true })).toThrow(ResolverError);
    expect(() =>
      parseResolverResponse({
        ok: false,
        ref: "x",
        error: "not_a_kind",
        message: "m",
      }),
    ).toThrow(ResolverError);
  });
});
