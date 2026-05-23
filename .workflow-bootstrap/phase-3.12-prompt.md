# Phase 3.12 — LLM Fallback for Very-Low-Confidence Claims

## Why

Run 7 dogfood passed design/hld/impl all on first try after Phase 3.11, then failed at `tests` with a real `claim_mismatch`. Looking at it: the test agent cited `src/HashRing.ts#addShard` with `claim="addShard for an already-present shard id throws; silent overwrite would corrupt the ring."` — that's a **narrative justification** (where "silent overwrite would corrupt the ring" is reasoning, not code). The function body throws but doesn't contain those words. Token overlap: ~0.30. Under current rules: hard fail.

Two failure modes the linter currently can't distinguish:
1. Agent paraphrases the section. Real match, low literal overlap.
2. Agent invents text untethered from the section. Hallucination.

`matchClaim` can't tell them apart at low overlap. Raising the bar excludes paraphrase (Run 6 problem). Lowering the bar admits hallucination (a worse outcome — citations become decoration).

The fix: when token overlap drops **below 0.3**, ask Claude. Claude is already on the box (the agent uses it). Two-line verdict: faithful or not. We're permissive everywhere else; the LLM only fires on the genuine suspicion zone.

## Required Reading (in order)

1. **`docs/aow-dogfood-findings.md`** — read the Run 7 entry and Finding 11 for context on why this matters.
2. **`packages/workflow/src/resolver/parse.ts`** (now ~310 LOC after 3.10/3.11) — `matchClaim` at line 280 is the function changing. `tokenize` / `STOPWORDS` unchanged.
3. **`packages/workflow/src/resolver/script.ts`** (~373 LOC) — the resolver subprocess. `resolveCitation` calls `matchClaim` at line ~212 (post-3.10). The LLM fallback hooks in here, not inside `matchClaim` (keep `matchClaim` pure and synchronous).
4. **`packages/workflow/src/citation-linter.ts`** — `claim_low_confidence` is always a warning post-fix. The new `claim_unfaithful` error kind needs adding here.
5. **`packages/workflow/src/types.ts`** — `ClaimMatch`, `LintFinding`, `ResolverErrorKind`. New `match_kind: "llm_verified"` and new `error: "claim_unfaithful"` go here.
6. **`docs/workflow-engine.md` §17** — document the new tier.
7. **`docs/aow-guide.md` §3** — user-facing note: "very low overlap → claude makes the call."
8. **`CLAUDE.md`** — repo conventions.

## The Design

### Threshold cascade (after Phase 3.12)

```
exact_substring        confidence 1.0       → pass
normalized_substring   confidence 0.85      → pass
token_overlap ≥ 0.3    confidence varies    → pass (warning if < 0.7)
token_overlap < 0.3    →  LLM CHECK
                          ├── faithful=true  → pass (match_kind: "llm_verified")
                          └── faithful=false → fail (error: claim_unfaithful)
zero tokens / no match → fail (claim_mismatch — existing)
```

The 0.3 boundary is the "very low" gate. Below 0.3 the LLM decides; above, the existing rules.

### `matchClaim` stays pure

`matchClaim` is a pure, sync function. Don't make it async — it's called from many places and the resolver subprocess invokes it via simple loops. Instead:

- `matchClaim` returns the same `ClaimMatch` shape. When overlap is in [0, 0.3), it returns `{ found: false, match_kind: "below_threshold", confidence }` — a NEW sentinel value meaning "I can't decide; ask the LLM."
- The CALLER (`resolveCitation` in `script.ts`) sees `match_kind === "below_threshold"` and invokes the LLM check, then **replaces** the match with either `{found:true, match_kind:"llm_verified", confidence:0.5, reason:...}` or `{found:false, match_kind:null, confidence, reason:...}`.

This keeps `matchClaim` synchronous + testable in isolation, and confines the subprocess-spawn complexity to one call site.

### The LLM checker

New file: `packages/workflow/src/resolver/llm-check.ts`. Single exported function:

```typescript
export interface LlmVerdict {
  faithful: boolean;
  reason: string;
}

export async function checkClaimWithClaude(args: {
  sectionContent: string;
  claim: string;
  timeoutMs?: number;
}): Promise<LlmVerdict | null>;  // null = tool unavailable / error
```

**Implementation contract:**

- Shell out via `node:child_process.execFile` (not `exec` — no shell injection risk):
  ```typescript
  execFile("claude", ["-p", "--output-format", "json", prompt], { 
    timeout: args.timeoutMs ?? 30_000, 
    encoding: "utf8",
    maxBuffer: 1_000_000,
  })
  ```
- Spawn-not-found / non-zero exit / timeout / unparseable output → **return `null`**, do not throw. Caller treats `null` as "couldn't check," logs a warning, and **passes the citation** (don't block workflows on tooling flakiness).
- Parse `stdout` as JSON (claude `-p --output-format json` returns `{type, result, ...}` where `result` is the model's text). Extract `.result`, parse THAT as JSON to get `{faithful, reason}`.
- If model output isn't valid JSON, return `null` (don't fail-closed on a parse error — same "couldn't check" path).

**The prompt** (build inside `llm-check.ts`, keep verbatim):

```
You verify that a "claim" comment in code accurately describes content present in a cited section. Reply ONLY with a single JSON object, no prose, no markdown.

Schema: {"faithful": <boolean>, "reason": "<short explanation>"}

Rules:
- "faithful": true means the claim describes content the section actually contains. Paraphrase is fine. Synonyms are fine.
- "faithful": false means the claim states something the section does NOT support, contradicts, or invents from thin air.
- When you are uncertain, answer faithful=false. Be strict — false positives (passing a bad citation) are worse than false negatives (rejecting a paraphrase the author will rewrite).

Examples:

SECTION:
function addShard(id) {
  if (this.shardIds.has(id)) throw new Error("duplicate");
  this.shardIds.add(id);
}
CLAIM: "addShard throws on duplicate shard id"
RESPONSE: {"faithful": true, "reason": "section throws on duplicate"}

SECTION:
function lookup(key) {
  return this.ring[hash(key) % this.ring.length].shardId;
}
CLAIM: "lookup uses consistent hashing with virtual nodes for even distribution"
RESPONSE: {"faithful": false, "reason": "section uses modulo, not consistent hashing; no vnodes here"}

Now evaluate:

SECTION:
<<<SECTION CONTENT INLINED>>>

CLAIM: <<<CLAIM INLINED>>>

RESPONSE:
```

Inline the section content and claim into the prompt by simple string interpolation. Cap section content at 4000 chars (truncate from the end with `... [truncated]` suffix if longer) so the prompt stays small. The claim is already short (typically <200 chars).

### How `script.ts` calls it

In `resolveCitation`, after computing the section body and calling `matchClaim`:

```typescript
let claimMatch = claim ? matchClaim(claim, body) : null;
if (claimMatch?.match_kind === "below_threshold") {
  const verdict = await checkClaimWithClaude({
    sectionContent: body,
    claim: claim!,
  });
  if (verdict === null) {
    // LLM unreachable — be permissive, warn upstream via match_kind.
    claimMatch = { found: true, match_kind: "llm_unavailable", confidence: claimMatch.confidence };
  } else if (verdict.faithful) {
    claimMatch = { found: true, match_kind: "llm_verified", confidence: 0.5, reason: verdict.reason };
  } else {
    // Synthesize a real mismatch.
    response = makeError(
      ref,
      "claim_unfaithful",
      `Claim contradicts or invents content not in section "${parsed.section}" of ${parsed.file}: ${verdict.reason}`,
    );
    // continue down the existing error path (appendHop etc.)
    ...
  }
}
```

The rest of the existing post-match logic (success path) is unchanged. Add the new error code to `ResolverErrorKind` and to `available_sections` plumbing isn't needed (the section exists; the claim is bad).

### `ClaimMatch` shape changes

Extend the existing union in `types.ts`:

```typescript
export type ClaimMatchKind =
  | "exact_substring"
  | "normalized_substring"
  | "token_overlap"
  | "below_threshold"   // NEW — internal, prompts LLM check
  | "llm_verified"      // NEW — LLM said faithful
  | "llm_unavailable";  // NEW — LLM couldn't be reached, permissive pass

export interface ClaimMatch {
  found: boolean;
  match_kind: ClaimMatchKind | null;
  confidence: number;
  reason?: string;       // NEW — populated by llm_verified
}
```

### Linter changes (`citation-linter.ts`)

- Add `"claim_unfaithful"` to the `LintErrorCode` / equivalent type.
- When the resolver returns `error: "claim_unfaithful"`, emit a `LintFinding` with `kind: "error"`, `code: "claim_unfaithful"`, message including the LLM's reason. This MUST be an error (unlike `claim_low_confidence` which is a warning) — the LLM specifically said the claim is wrong.
- When the resolver returns `claim_match.match_kind === "llm_verified"`, emit NO finding (clean pass).
- When `match_kind === "llm_unavailable"`, emit a `LintFinding` with `kind: "warning"`, `code: "claim_low_confidence"`, message noting LLM was unavailable so the citation was passed under low confidence.

## Tests to add

In `packages/workflow/src/__tests__/resolver/parse.test.ts`:

- `matchClaim` returns `match_kind: "below_threshold"` (NOT `null`) for token overlap in [0, 0.3) with non-empty tokens.
- Returns `null` match_kind only when token list is empty (preserving current behavior).
- All existing passes still pass.

In a new file `packages/workflow/src/__tests__/resolver/llm-check.test.ts`:

- Mock `execFile` via `vi.mock("node:child_process", ...)` to return canned `claude -p` output.
- Test: clean `{faithful: true}` JSON in `.result` → returns `{faithful: true, reason: ...}`.
- Test: `{faithful: false}` → returns `{faithful: false, reason: ...}`.
- Test: execFile throws ENOENT (claude not on PATH) → returns `null`.
- Test: execFile times out (signal SIGTERM) → returns `null`.
- Test: execFile returns malformed JSON → returns `null`.
- Test: execFile returns valid outer JSON but `.result` is malformed → returns `null`.
- Test: section content > 4000 chars → truncation suffix present in the prompt passed to execFile.

In `packages/workflow/src/__tests__/integration/phase-3-12.integration.test.ts` (new):

- Mock the LLM checker module (`vi.mock("../resolver/llm-check.js", ...)`) so the test doesn't actually shell to claude.
- Synthesize an `.md` with a section, an output file with a claim that has token overlap ~0.15, mock checker returns `{faithful: true}`. Lint passes; finding has `match_kind: "llm_verified"`.
- Same setup but checker returns `{faithful: false}`. Lint fails with `claim_unfaithful` error including the reason.
- Same setup but checker returns `null` (unavailable). Lint passes with `claim_low_confidence` warning.
- Regression: overlap ≥ 0.3 case — checker MUST NOT be called.

## Files to Modify / Create

```
packages/workflow/src/types.ts                                            modify
packages/workflow/src/resolver/parse.ts                                   modify (matchClaim)
packages/workflow/src/resolver/script.ts                                  modify (resolveCitation post-match branch)
packages/workflow/src/resolver/llm-check.ts                               CREATE
packages/workflow/src/citation-linter.ts                                  modify (new code + finding shape)
packages/workflow/src/__tests__/resolver/parse.test.ts                    modify (below_threshold sentinel)
packages/workflow/src/__tests__/resolver/llm-check.test.ts                CREATE
packages/workflow/src/__tests__/integration/phase-3-12.integration.test.ts CREATE
docs/workflow-engine.md                                                   modify (§17 tier cascade)
docs/aow-guide.md                                                         modify (§3 user-facing note)
```

## Hard Constraints

- Modify ONLY `packages/workflow/` and `docs/`.
- Strict TS, no `any`, per-file LOC cap 400. `llm-check.ts` should land at <150 LOC easily.
- All existing tests stay green. Add the tests above.
- **No new runtime dependencies.** Use `node:child_process.execFile` (built-in). Do NOT add `@anthropic-ai/sdk` or anything else to `package.json`.
- **No caching.** Do not write any cache file, do not memoize across calls. Each call shells out fresh.
- **No API key handling.** The resolver does not read `ANTHROPIC_API_KEY` or set any env. It relies on the `claude` CLI's own auth (which the user already has, since the workflow agent IS claude-code).
- One PR targeting `feature/workflow-engine`.
- Use `git pull` (merge), NOT `git pull --rebase`.

## Acceptance

```bash
pnpm --filter @aoagents/ao-workflow build
pnpm --filter @aoagents/ao-workflow test     # existing + new tests pass
pnpm typecheck
```

Manual smoke (document in PR body):

```bash
# Stage a tiny section + a deliberately-paraphrased claim with overlap ~0.15.
mkdir -p /tmp/aow-smoke/artifacts
cat > /tmp/aow-smoke/artifacts/foo.md <<'EOF'
# Foo
## bar
Throws on duplicate id; the registry uses a Set internally.
EOF

cat > /tmp/aow-smoke/artifacts/uses.md <<'EOF'
# Uses Foo
<!-- ref: foo.md#bar claim="bar guarantees uniqueness because identical ids are rejected" -->
EOF

# This will actually shell out to `claude -p` — expect a 5-30s pause.
node packages/workflow/dist/resolver/script.js 'foo.md#bar' \
  --claim 'bar guarantees uniqueness because identical ids are rejected' \
  --artifacts-dir /tmp/aow-smoke/artifacts \
  --workspace-path /tmp/aow-smoke \
  --step-id smoke
# Expected: { ok: true, ..., claim_match: { match_kind: "llm_verified", reason: "..." } }
```

The human will re-run the URL-shortener dogfood post-merge.

## When Done

1. Verify acceptance.
2. Commit: `feat(workflow): phase 3.12 — LLM fallback for very-low-confidence claims`
3. Push.
4. PR: `gh pr create --base feature/workflow-engine --title 'feat(workflow): phase 3.12 — LLM fallback for very-low-confidence claims'`
5. PR body: describe the design (3-tier cascade, 0.3 boundary, claude -p shell-out, no cache, no key, no SDK), list files added/modified, paste the manual smoke output, note `claude` CLI must be on PATH.

## Out of Scope

- Caching the LLM verdicts (over-engineering for now).
- Using the Anthropic API SDK or any API key.
- Stemming or synonym tables (rejected in Phase 3.11 design).
- Re-verifying earlier phases.
- Finding 10 (zombie sessions).
- Any file outside `packages/workflow/` and `docs/`.
