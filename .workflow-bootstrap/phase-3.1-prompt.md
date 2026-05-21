# Phase 3.1 — Resolver Script + Schema

## Required Reading

1. `docs/workflow-engine.md` — design spec. Read **end-to-end** before doing anything. Especially:
   - §16 (Reference preservation across steps) — the citation format you must support
   - §17.1 (Resolver Script — `.ao/aow-ref`) — the **exact** contract this PR implements
   - §17.5 / §17.6 (Phase 3 scope and out-of-scope)
   - Glossary
2. **Existing Phase 0–2 modules — read every one of these in `packages/workflow/src/` before designing**:
   - `types.ts` — extend with new Phase 3 types (do NOT redefine existing types)
   - `errors.ts` — extend with a new error class following the existing naming convention
   - `artifact-store.ts` — has `resolveArtifactPath(artifactsDir, relPath)` for **path-escape safety**; reuse it
3. `CLAUDE.md` — repo conventions.

## What This PR Delivers

A standalone Node script that resolves a citation (e.g. `"design.md#auth-flow"`) and returns schema-validated JSON. **No engine wiring yet** — that lands in 3.2. The script must be invokable as:

```bash
node packages/workflow/dist/resolver/script.js "design.md#auth-flow"
node packages/workflow/dist/resolver/script.js "design.md#auth-flow" --claim "bcrypt cost factor 12"
```

It is a pure function over the filesystem. Zero external runtime deps (uses only `node:fs`, `node:path`, `node:crypto`, and the local `schema.ts`).

## Files to Create

1. **`packages/workflow/src/resolver/schema.ts`**
   - Zod schema for `ResolverResponse` (and its sub-shapes: `ClaimMatch`, error variants).
   - Exported helpers: `resolverResponseSchema`, `parseResolverResponse(raw: unknown): ResolverResponse` (throws on invalid).
   - **Shared between the script (which asserts before printing) and the engine (which validates on read).**
   - Reuses the `WorkflowErrorCode` style from `errors.ts` for `error` kind enum values.

2. **`packages/workflow/src/resolver/script.ts`**
   - Implementation of the resolver per §17.1.
   - Exports a single async function `resolveCitation(args: ResolveArgs): Promise<ResolverResponse>` plus a CLI wrapper that:
     1. Parses `argv[2]` as the ref string and optional `--claim "<text>"` and `--artifacts-dir <abs>` / `--workspace-path <abs>` flags. `--artifacts-dir` defaults to the cwd if not provided. `--workspace-path` defaults to `process.cwd()` and is the directory whose `.ao/ref-hops.jsonl` receives the hop log. `--step-id <id>` is required for hop logging — defaults to the env var `AOW_STEP_ID` if not passed.
     2. Calls `resolveCitation`.
     3. Validates the result via the schema.
     4. Writes the JSON to stdout.
     5. Exits 0 on `ok: true`, non-zero on `ok: false`.
   - Append exactly one JSON line to `<workspacePath>/.ao/ref-hops.jsonl` per invocation (create the file/dir if missing). Shape: `{ ts, step_id, ref, outcome, match_kind }`.
   - **Hop-depth warning**: count entries in `.ao/ref-hops.jsonl` whose `step_id` matches the current invocation. If count > 4 **after appending the current entry**, include `warnings: ["hop_depth_4"]` in the response on `ok: true` responses.
   - The TypeScript file builds to `dist/resolver/script.js` via the package's existing `tsc` build. Add `#!/usr/bin/env node` shebang so the file is invokable directly after `chmod +x`.

   **Citation parsing rules** (per §16):
   - Markdown comments: `<!-- ref: <file>#<section> claim="..." -->`
   - Code/JSON/YAML: `// ref: <file>#<section> claim="..."`
   - `<section>` is the **GitHub-Markdown slug**: lowercase, spaces → `-`, strip punctuation other than `-`. Implement slugification inline; do not pull a slug library.
   - File-level refs (no `#`) are permitted; resolve as the whole file's content.
   - `claim` is optional in the **ref input**, but if present on the CLI via `--claim` you perform a tier match.

   **Three-tier claim matching** (per §17.1):
   1. `exact_substring` — case-sensitive, whitespace-preserved substring match → `confidence: 1.0`
   2. `normalized_substring` — lowercase both sides, collapse runs of whitespace to a single space, strip surrounding punctuation, then substring match → `confidence: 0.85`
   3. `token_overlap` — tokenize the claim: drop stopwords (use a hardcoded ~20-word English stopword list inline) and tokens < 4 chars. Match if every remaining token appears (substring, case-insensitive) somewhere in the section content. `confidence = matched / total`, floor 0.5 to register a match.

   On no match: `claim_match: { found: false, match_kind: null, confidence: 0.0 }` and the top-level `ok: false` with `error: "claim_mismatch"`.

   **Closed-set error kinds** (per §17.1):
   - `file_not_found` — cited file does not exist
   - `section_not_found` — file exists, anchor doesn't (response includes `available_sections: string[]`)
   - `claim_mismatch` — claim provided, no tier matched
   - `malformed_ref` — input string did not parse
   - `outside_artifacts_dir` — resolved path escapes `--artifacts-dir`. **Use `resolveArtifactPath` from `artifact-store.ts` to enforce this.**

3. **`packages/workflow/src/__tests__/resolver/schema.test.ts`**
   - At least 6 tests: schema accepts each shape (ok+match, ok+no-claim, each error kind, with warnings); `parseResolverResponse` throws on malformed input.

4. **`packages/workflow/src/__tests__/resolver/script.test.ts`**
   - Fixture-based. Create `packages/workflow/src/__tests__/resolver/fixtures/` with:
     - `design.md` — has at least 2 sections; one section's body contains `"bcrypt cost factor 12"` for the exact-tier test.
     - `hld.md` — contains a citation comment referencing `design.md#auth-flow` (for outgoing_refs).
     - A code file (e.g. `sample.ts`) using the `// ref:` form.
   - At least 12 tests covering:
     - Each of the 5 error kinds returns `ok: false` and the right shape.
     - Each of the 3 match tiers (exact, normalized, token_overlap) returns the right `match_kind` and confidence.
     - `--artifacts-dir` rejection of `../escape` paths.
     - File-level ref (no `#`) returns the whole file content.
     - Hop log is appended (read the file and assert the JSON shape).
     - `warnings: ["hop_depth_4"]` is emitted on the 5th hop for the same `step_id`.
     - Invocations for **different** `step_id` values do not trigger the warning even past hop 4 cumulatively.
   - Run the CLI via `child_process.execFile` against the built script (`dist/resolver/script.js`), OR call `resolveCitation` directly with the same args object and separately unit-test the argv parser. Either approach is fine; prefer the direct call for speed.

## Files to Modify

1. **`packages/workflow/src/types.ts`** — add (in this order, near the existing `Artifact`/`ArtifactRef` block):

   ```ts
   export type ResolverErrorKind =
     | "file_not_found"
     | "section_not_found"
     | "claim_mismatch"
     | "malformed_ref"
     | "outside_artifacts_dir";

   export type ResolverMatchKind =
     | "exact_substring"
     | "normalized_substring"
     | "token_overlap";

   export interface ClaimMatch {
     found: boolean;
     match_kind: ResolverMatchKind | null;
     confidence: number; // 0.0–1.0
   }

   export interface Citation {
     file: string;        // relative to artifacts_dir
     section: string | null; // null for file-level refs
     claim: string | null;
   }

   export interface HopRecord {
     ts: string;          // ISO timestamp
     step_id: string;
     ref: string;
     outcome: "ok" | "error";
     match_kind: ResolverMatchKind | null;
   }

   export type ResolverResponse =
     | {
         ok: true;
         ref: string;
         artifact_relative_path: string;
         section_heading: string | null; // null for file-level refs
         section_content: string;
         outgoing_refs: Citation[];
         claim_match: ClaimMatch | null;  // null when no claim was provided
         warnings?: string[];
       }
     | {
         ok: false;
         ref: string;
         error: ResolverErrorKind;
         message: string;
         available_sections?: string[]; // only set for section_not_found
       };
   ```

   Do **not** modify any other existing type. Do **not** add Phase 3.4 / 3.5 fields like `StepState.warnings` or `AttemptRecord.workspace_path` in this PR — those land in their own phases.

2. **`packages/workflow/src/errors.ts`** — add **at the end** of the file:

   ```ts
   export class ResolverError extends WorkflowError {
     constructor(message: string, options?: ErrorOptions) {
       super("WF_RESOLVER", message, options);
       this.name = "ResolverError";
     }
   }
   ```

   And extend the `WorkflowErrorCode` union with `| "WF_RESOLVER"`.

3. **`packages/workflow/src/index.ts`** — extend public exports with the new resolver types and the resolver entry function `resolveCitation`. Do not remove or re-shape existing exports.

4. **`packages/workflow/package.json`** — no changes needed if the existing `tsconfig` already emits `src/resolver/*.ts` (it does via `"outDir": "dist"`). Verify by reading `tsconfig.json` and `dist/` after building.

## Hard Constraints

- Modify ONLY `packages/workflow/`. Add the new files; modify only `types.ts`, `errors.ts`, `index.ts`. Do NOT touch `state-store.ts`, `step-runner.ts`, `cli.ts`, `prompt-template.ts`, or any other existing module — those changes belong to later phases.
- The resolver script must have **zero new runtime dependencies**. No new `dependencies` entries in `package.json`. Only `node:fs`, `node:path`, `node:crypto`, plus the package's own `schema.ts` and `artifact-store.ts`.
- The resolver script does NOT import from `@aoagents/ao-core`. It is a standalone tool.
- The resolver script writes to **`<workspacePath>/.ao/ref-hops.jsonl`** for the hop log, not to the run dir. Per §17.1.
- All script-emitted JSON must validate against the Zod schema. The script must assert this before printing — if its own output fails the schema, throw and exit non-zero so we catch bugs early instead of shipping invalid JSON.
- Strict TS. No `any`. Use `unknown` + narrowing where needed (e.g. validating `argv` flags, parsing user-supplied claim).
- Max 400 LOC per file. If `script.ts` grows past that, split parsing / matching / hop-logging into helper files in `src/resolver/`.
- The slug function and the stopword list go inline — do NOT add a markdown-it or slugger dep.
- Do NOT shell out to anything. Pure Node FS only.

## Path Safety (Important)

Every file read in the script must go through `resolveArtifactPath(artifactsDir, relPath)` from `artifact-store.ts`. If that throws (escape attempt or invalid relative path), return `ok: false, error: "outside_artifacts_dir"`. This is the single most important security property of the resolver — the agent process invokes it with attacker-controlled (LLM-controlled) ref strings.

## Acceptance — All Must Pass

```bash
pnpm --filter @aoagents/ao-workflow build
pnpm --filter @aoagents/ao-workflow test    # all existing + new resolver tests pass
pnpm typecheck                              # whole repo

# Manual smoke (document the output in the PR body):
node packages/workflow/dist/resolver/script.js \
  "design.md#auth-flow" \
  --claim "bcrypt cost factor 12" \
  --artifacts-dir packages/workflow/src/__tests__/resolver/fixtures \
  --workspace-path /tmp/aow-resolver-smoke \
  --step-id smoke-test

# Also smoke each error kind: malformed ref, missing file, missing section, escape attempt, claim mismatch.
```

## When Done

1. Verify all acceptance commands pass.
2. Commit: `feat(workflow): phase 3.1 — resolver script + schema`
3. Push.
4. `gh pr create --base feature/workflow-engine --title 'feat(workflow): phase 3.1 — resolver script + schema'`
5. PR body should include:
   - Files added / modified
   - Confirmation that the acceptance commands pass
   - The output of the 6 smoke invocations (happy path + 5 error kinds)
   - Note: no engine wiring yet — that's 3.2. This PR's only consumers are (a) any human running the script manually and (b) the unit tests.

## Out of Scope (DO NOT DO IN THIS PR)

- Workspace setup hook (dropping the script into agent worktrees) — that is phase 3.2.
- Prompt contract footer extension — that is phase 3.3.
- Citation linter — that is phase 3.4.
- `aow show --hops` CLI flag — that is phase 3.5.
- Any change to `StepState`, `AttemptRecord`, `step-runner.ts`, `cli.ts`, `prompt-template.ts`, `state-store.ts`.
- Any new top-level dependencies.
- Any change outside `packages/workflow/`.
