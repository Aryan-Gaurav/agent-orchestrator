import { z } from "zod";

import { ResolverError } from "../errors.js";
import type { ResolverResponse } from "../types.js";

const resolverErrorKindSchema = z.enum([
  "file_not_found",
  "section_not_found",
  "claim_mismatch",
  "malformed_ref",
  "outside_artifacts_dir",
]);

const resolverMatchKindSchema = z.enum([
  "exact_substring",
  "normalized_substring",
  "token_overlap",
]);

const claimMatchSchema = z.object({
  found: z.boolean(),
  match_kind: resolverMatchKindSchema.nullable(),
  confidence: z.number().min(0).max(1),
});

const citationSchema = z.object({
  file: z.string().min(1),
  section: z.string().nullable(),
  claim: z.string().nullable(),
});

const okSchema = z.object({
  ok: z.literal(true),
  ref: z.string(),
  artifact_relative_path: z.string(),
  section_heading: z.string().nullable(),
  section_content: z.string(),
  outgoing_refs: z.array(citationSchema),
  claim_match: claimMatchSchema.nullable(),
  warnings: z.array(z.string()).optional(),
});

const errSchemaBase = z.object({
  ok: z.literal(false),
  ref: z.string(),
  error: resolverErrorKindSchema,
  message: z.string(),
  available_sections: z.array(z.string()).optional(),
});

export const resolverResponseSchema: z.ZodType<ResolverResponse> =
  z.union([okSchema, errSchemaBase]) as unknown as z.ZodType<ResolverResponse>;

export function parseResolverResponse(raw: unknown): ResolverResponse {
  const result = resolverResponseSchema.safeParse(raw);
  if (!result.success) {
    throw new ResolverError(
      `Resolver response failed schema validation: ${result.error.message}`,
      { cause: result.error },
    );
  }
  return result.data;
}
