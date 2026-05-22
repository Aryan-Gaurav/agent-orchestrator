# Phase 3.11 — Loose Claim Matching (Threshold + Prefix)

## Why

Re-dogfood Run 6 (post Phase 3.10) failed at `impl` with 4 `claim_mismatch` errors. The cited Markdown sections exist and contain the right content — the agent's *paraphrase* of the section doesn't survive `matchClaim`'s 100%-token-coverage rule.

Reproduction: agent wrote `claim="Shortener generates random 7-char base62 code, routes via ring, setIfAbsent with retry up to 5x"`; the section body says "...generate a random 7-char base62 code, ask the ring for the owning shard, attempt setIfAbsent, retry on collision up to 5 times." `generates` ≠ `generate`, `routes` ≠ `ask`. Token coverage 0.78. Current rule: requires 1.0. → rejected.

This blocks every workflow whose downstream steps cite an upstream design — i.e., every realistic workflow. Findings 11 in `docs/aow-dogfood-findings.md` has the full diagnosis.

## Required Reading (in order)

1. **`docs/aow-dogfood-findings.md` "Run 6" + "Finding 11"** — the symptom, the reproduction, the reasoning behind the chosen fix.
2. **`packages/workflow/src/resolver/parse.ts`** (145 LOC) — `matchClaim` (line 117), `tokenize` (line 110), `normalize` (line 102), `STOPWORDS` (line 6). This is the only file with logic to change.
3. **`packages/workflow/src/__tests__/resolver/parse.test.ts`** — existing tests for `matchClaim`. New cases go here.
4. **`docs/workflow-engine.md` §17** — "Reference Resolution / Citation Validation." Document the new threshold + prefix rule.
5. **`docs/aow-guide.md` §3** — user-facing "Citation contract." State the new rule plainly so workflow authors understand what passes.
6. **`CLAUDE.md`** — repo conventions.

## The Bug in One Line

`parse.ts:136`:

```typescript
if (matched === tokens.length && confidence >= 0.5) {
```

Requires **all** tokens present *and* confidence ≥ 0.5. Since `confidence = matched / tokens.length`, those two conditions together collapse to "100% literal coverage." There's no surface-form tolerance and no prefix tolerance.

## The Fix

Two adjustments to `matchClaim`, both targeting realistic paraphrase without weakening "agent invented this" detection.

### Change 1 — Threshold drops to 50%

Replace the existing rule with:

```typescript
if (confidence >= 0.5) {
  return { found: true, match_kind: "token_overlap", confidence };
}
return { found: false, match_kind: null, confidence: 0.0 };
```

(Note: `confidence >= 0.5` is the *only* gate. The `matched === tokens.length` clause is dropped.)

**Why 50%:** half the load-bearing tokens still appear literally → claim is grounded in the section, not fabricated. An agent who invents a claim with no relationship to the cited section will score near zero. The risk is a noisy "almost matches" case slipping through; that's acceptable for v1 — it's caught by humans on the next step's review, and false positives are far cheaper than the current rate of false negatives.

### Change 2 — Token prefix matching counts

Today, `matched` is incremented only when a tokenized claim word appears as a substring in lowercased section content. Extend it: a claim token counts as matched if **any token in the section starts with it OR the claim token starts with any section token (minimum 4 chars on both sides).**

Specifically:

- Pre-tokenize the section the same way the claim is tokenized (length ≥4, non-stopword, lowercase).
- For each claim token, count it as matched if:
  - it appears as a substring in lowercased section content (existing behavior), OR
  - some section token T has length ≥4 AND (T.startsWith(claimToken) OR claimToken.startsWith(T))

This catches `generates`↔`generate`, `routes`↔`route`/`routing`, `lookup`↔`look`/`looking`, `generation`↔`generate`. Both directions matter — sometimes the agent shortens (`route`), sometimes the section does (`gen`).

Minimum-length 4 is critical: without it, `set`↔`setup`, `set`↔`setIfAbsent`, etc. start matching noise.

### What does NOT change

- `STOPWORDS` list (`parse.ts:6`).
- `tokenize` (`parse.ts:110`) — same rule (length ≥4, non-stopword, lowercased, split on non-alphanum).
- `exact_substring` and `normalized_substring` match paths and their confidence scores (1.0 and 0.85). These are still tried first and short-circuit return.
- The `token_overlap` `match_kind` label (today's soft-warning code at `engine/citation-step.ts` uses it to surface a "low confidence" warning when confidence < 0.7; that behavior remains).

## Files to Modify

### 1. `packages/workflow/src/resolver/parse.ts`

Rewrite `matchClaim` (lines 117–140):

```typescript
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
```

### 2. `packages/workflow/src/__tests__/resolver/parse.test.ts`

Add `matchClaim` tests for each new behavior. Use realistic short fixtures (4–6 line sections, not the full URL-shortener corpus).

- **Verbatim claim still matches as `exact_substring` (regression).** Claim is a verbatim substring of the section → `match_kind === "exact_substring"`, `confidence === 1.0`.
- **Paraphrase passes with prefix match.** Section: "generate a random 7-char base62 code". Claim: "Shortener generates random 7-char base62 code". Expect `found: true`, `match_kind: "token_overlap"`, `confidence >= 0.5`. (Prefix: `generates` matches `generate`.)
- **50%-threshold passes.** Section: "alpha beta gamma delta epsilon". Claim contains 5 ≥4-char non-stopword tokens, exactly 3 (60%) appear → `found: true`.
- **49%-threshold fails.** Same setup but only 2 of 5 tokens match → `found: false`.
- **Prefix below 4 chars does NOT match.** Claim token "set" and section token "setIfAbsent" — token "set" is length 3, gets filtered out by `tokenize` anyway. Verify a `claim="set up"` against section "setIfAbsent" returns `found: false` (because the claim's only ≥4 token doesn't exist).
- **Prefix bidirectional.** Section has "routing"; claim has "routes". `routes.startsWith("rout") && "routing".startsWith("rout")` — actually neither is a prefix of the other. Use a real pair: section "route", claim "routes" (5-char `routes` startsWith 5-char `route`? No — `routes` has length 6, `route` length 5, so `"routes".startsWith("route")` is `true`). Expect match. Symmetric test: section "routes", claim "route" → `"routes".startsWith("route")` still true → match.
- **Totally invented claim fails.** Section about HashRing; claim says "implements RAFT consensus protocol". Zero overlap → `found: false`.
- **Phase 3.10 regression.** A code-symbol citation (`Foo.ts#bar` resolving to a function body) still works end-to-end after the looser rule. One integration test in `__tests__/integration/` that uses a real `.ts` file + paraphrased claim and asserts the resolver returns `ok: true`.

### 3. `packages/workflow/src/__tests__/integration/phase-3-11.integration.test.ts` (new)

Mirror the structure of `phase-3-10.integration.test.ts`. Add one end-to-end case: synthetic `hld.md` with `### Shortener` section, synthetic `Shortener.ts` with `// ref: hld.md#shortener claim="paraphrased version"`, run the linter → expect zero errors (warning is fine).

### 4. Documentation

**`docs/workflow-engine.md` §17:** add a subsection "Claim matching tiers" listing the cascade — exact_substring (1.0) → normalized_substring (0.85) → token_overlap (≥0.5 with prefix tolerance). Explicitly mention the 4-character prefix minimum.

**`docs/aow-guide.md` §3:** under "Citation contract" add a paragraph: "Claims need not be verbatim. The linter accepts the cited section if at least half of the claim's load-bearing words (≥4 characters, non-stopword) appear in the section, either literally or as a 4+ character prefix (so `generates` matches `generate`)."

## Hard Constraints

- Modify ONLY `packages/workflow/` (+ `docs/`).
- Strict TS, no `any`, per-file LOC cap 400.
- All existing tests stay green. Old tests asserting the previous 100% threshold need their assertions adjusted (NOT deleted) to match the new rule — flag any such updates in the PR body.
- One PR targeting `feature/workflow-engine`.
- Use `git pull` (merge), NOT `git pull --rebase`.

## Acceptance — All Must Pass

```bash
pnpm --filter @aoagents/ao-workflow build
pnpm --filter @aoagents/ao-workflow test
pnpm typecheck
```

Manual smoke (document in PR body):

```bash
# The exact Run-6 failure should now succeed.
node -e '
const { matchClaim } = require("./packages/workflow/dist/resolver/parse.js");
const section = "Orchestrates the write path: generate a random 7-char base62 code, ask the ring for the owning shard, attempt setIfAbsent, retry on collision up to 5 times.";
const claim = "Shortener generates random 7-char base62 code, routes via ring, setIfAbsent with retry up to 5x";
console.log(matchClaim(claim, section));
'
# Expected: { found: true, match_kind: "token_overlap", confidence: >= 0.5 }
```

The human will re-run the URL-shortener dogfood post-merge — that run verifies both Phase 3.10 (code-symbol anchors) AND Phase 3.11 (loose claim matching) end-to-end.

## When Done

1. Verify acceptance.
2. Commit: `feat(workflow): phase 3.11 — loose claim matching (50% + prefix)`
3. Push.
4. PR: `gh pr create --base feature/workflow-engine --title 'feat(workflow): phase 3.11 — loose claim matching'`
5. PR body: describe the bug (cite Run 6 + Finding 11), list files changed, paste the manual smoke output, note which old tests had assertions adjusted (and why).

## Out of Scope

- Stemming (Porter algorithm, suffix tables). Prefix match catches the common cases; ship simpler thing first.
- Synonym tables.
- LLM-based semantic match.
- A `--claim-strict` opt-back flag (no current consumer wants the old behavior).
- Phase 3.10 re-verification (that happens in the post-merge dogfood, not in this PR).
- Finding 10 (zombie sessions) — separate phase.
- Any file outside `packages/workflow/` and `docs/`.
