# Phase 3.10 — Resolver: Code-Symbol Anchors

## Why

Re-dogfood Run 5 (URL shortener, post Phase 3.9) advanced 3 of 4 steps end-to-end. The `tests` step failed at max_revisions, but the agent's *output* was correct (vitest passed 10/10, real HTTP server smoke-tested green). The block was purely linter — the agent cited code files using function-name anchors:

```
// ref: src/Shortener.ts#shorten claim="..."
// ref: src/HashRing.ts#addShard claim="..."
```

…and the resolver answered:

```
[section_not_found] __tests__/Shortener.test.ts:src/Shortener.ts#shorten — Section "shorten" not found
```

Because the section extractor only knows about Markdown `#` headings. Function declarations are invisible.

Until this is fixed, real software workflows can't pass the citation gate on test/impl steps — only docs-to-docs chains. The Phase 3.9 dogfood proved this in production.

## Required Reading (in order)

1. **`docs/aow-dogfood-findings.md`** — read the Run 5 section (we'll append it before merging this brief). For now, the failure mode is described in the "Why" above.
2. **`packages/workflow/src/resolver/parse.ts`** (145 LOC) — pure parsing helpers. `extractSections` (line 49) is the function to extend. `slugify` (line 11) is fine as-is.
3. **`packages/workflow/src/resolver/script.ts`** (372 LOC) — the resolver subprocess. `resolveCitation` (line 111) is the entry. Section lookup happens at line 195 (`const sections = extractSections(content);`).
4. **`packages/workflow/src/citation-linter.ts`** (316 LOC) — the linter that calls the resolver subprocess. Likely no changes needed, but read it to confirm.
5. **`docs/workflow-engine.md` §17** (Reference Resolution / Citation Validation) — the design contract. The new behavior needs to be documented there.
6. **`docs/aow-guide.md` §3** ("Citation contract") — user-facing rules. Add the code-symbol rule.
7. **`CLAUDE.md`** — repo conventions.

## The Bug in One Line

`extractSections(content)` in `parse.ts:49` only emits sections for lines matching `/^(#{1,6})\s+(.+?)\s*$/`. Source files have no such headings, so every code-symbol citation fails `section_not_found`.

## The Fix

Extend the resolver to extract **symbol "sections"** from source files. For a `.ts` / `.js` / `.tsx` / `.jsx` file, a section is any top-level or class-method declaration name. The existing Markdown path stays unchanged.

### Scope decisions (locked — do not redesign)

- **Languages in v1:** TypeScript + JavaScript (`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`). Other languages → fall back to existing "no sections" behavior, the agent gets a clear `section_not_found` with available slugs listed.
- **Parser:** **regex-based**, not a real TS parser. We only need declaration names, not type info. AST parsing (`typescript` package) is overkill and pulls in a multi-MB dep. The agent's citations don't need to compile — they need to find a function name that exists in the file. Regex is sufficient and keeps the resolver subprocess fast.
- **Slug rule:** identifiers are slugified through the same `slugify()` as headings, so `shardForKey` → `shardforkey`. The agent can cite either form (`#shardForKey` or `#shardforkey`); both normalize to the same slug. This matches the existing slug-tolerance pattern from Phase 3.8.
- **Section body for code:** the body is "from the declaration line to either the next top-level declaration OR end of file." Good enough for `matchClaim` to find the cited claim text inside the relevant function. Don't try to parse braces — regex hits work.

### Patterns to detect (per file extension `.ts` / `.tsx` / `.js` / `.jsx` / `.mts` / `.cts` / `.mjs` / `.cjs`)

| Construct | Regex sketch |
|---|---|
| `export function foo(`, `function foo(` | `/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/m` |
| `export class Foo`, `class Foo` | `/^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/m` |
| `export const foo = `, `const foo = ` (top-level only) | `/^(?:export\s+)?(?:const\|let\|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/m` |
| `export interface Foo`, `interface Foo` | `/^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/m` |
| `export type Foo =`, `type Foo =` | `/^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[<=]/m` |
| `export enum Foo`, `enum Foo` | `/^(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)\b/m` |
| Class method (inside any `class { ... }` block) | `/^\s+(?:public\|private\|protected\|static\|async\|\s)+?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/m` — match lines indented inside a class body |

**Important:** these are line-anchored (`^` with `m` flag), matching top-of-line patterns. The intent: capture declarations the *agent* would naturally cite (`Shortener.shorten`, `HashRing.addShard`, `generateCode`), not every expression that happens to define a name.

For methods, prefix with the enclosing class name: `Shortener#shorten` → slug `shortenershort en` — actually NO, **don't** prefix. The agent cites `src/Shortener.ts#shorten`, not `src/Shortener.ts#Shortener.shorten`. Match the agent's natural pattern: bare method name within the file. If two classes in one file both have a `shorten` method, both register — the agent's citation will match the first one it finds, which is fine (this is an edge case our workflows don't hit).

### What changes

**`packages/workflow/src/resolver/parse.ts`:**

- Add a new exported function `extractCodeSections(content: string): Section[]` that runs the regex set above and returns `Section[]` in the same shape as `extractSections`. `startLine` = the line of the declaration. `endLine` = the line of the next top-level declaration or `lines.length`.
- Add a small helper `isCodeFile(path: string): boolean` — true if `path` ends with one of the listed extensions.
- Keep `extractSections` exactly as-is (Markdown only). No behavior change to the existing path.

**`packages/workflow/src/resolver/script.ts`:**

- Inside `resolveCitation`, after determining `absPath` and reading `content` (lines ~155-172), choose the extractor:
  ```typescript
  const sections = isCodeFile(parsed.file)
    ? extractCodeSections(content)
    : extractSections(content);
  ```
- The rest of the lookup logic (line 196 onward) is unchanged — `targetSlug = slugify(parsed.section.replace(/_/g, " "))`, find matching section, run `matchClaim` against `sectionBody`.
- Update the import block at the top to include the two new exports.

**`packages/workflow/src/__tests__/resolver/`:**

- Extend the existing tests with cases for code-symbol anchors. Use a synthetic `.ts` content string — don't read real files.

### Tests to add

In `packages/workflow/src/__tests__/resolver/parse.test.ts` (or `extractCodeSections.test.ts` — pick the existing pattern):

- `extractCodeSections` finds an `export function shorten` and returns a Section with slug `shorten`.
- Finds `export class HashRing` with slug `hashring`.
- Finds a class method `shardForKey` with slug `shardforkey`.
- Finds `export const generateCode = ...` with slug `generatecode`.
- Returns empty array for an empty file.
- Returns empty array for a file with only comments and imports.
- Multiple declarations in one file are all captured.

In `packages/workflow/src/__tests__/resolver/script.test.ts` (the existing one already covers a lot):

- Resolving `Shortener.ts#shorten` against a `.ts` file that declares `export function shorten()` → `ok: true`.
- Resolving `HashRing.ts#addShard` against a class-method declaration → `ok: true`.
- Resolving `Shortener.ts#nonexistent` against a `.ts` file → `section_not_found` with `available_sections` listing the actual symbols.
- Resolving `design.md#functional-requirements` against a `.md` file → still works (existing path untouched).
- Resolving with `--claim` text that appears inside the function body → `claim_match.found: true`.

In `packages/workflow/src/__tests__/integration/phase-3-10.integration.test.ts` (new file, mirror Phase 3.8 / 3.9):

- End-to-end: lint a synthetic test file that cites `src/Foo.ts#bar` where `Foo.ts` defines `function bar()` → lint passes.

### Documentation

**`docs/workflow-engine.md` §17:** add a subsection "Code-symbol anchors" explaining:
- For `.ts`/`.tsx`/`.js`/`.jsx`/`.mts`/`.cts`/`.mjs`/`.cjs` files, `#fragment` matches a top-level declaration or class method by name.
- Slugified via the same rule as Markdown headings — case-insensitive match works.
- Body for matching the `claim` is "from the declaration line to the next top-level declaration."
- Other languages fall through to "no sections" — citation file-only (no fragment) still works.

**`docs/aow-guide.md` §3** ("Citation contract"): add a one-paragraph example showing both flavors:

```typescript
// ref: src/Shortener.ts#shorten claim="generates a 7-char base62 code"
```

```markdown
<!-- ref: design.md#id-generation-and-collisions claim="rejection sampling on bytes ≥ 248" -->
```

## Hard Constraints

- Modify ONLY `packages/workflow/`. Doc files in `docs/` are also fair game.
- Strict TS, no `any`, per-file LOC cap 400.
- All existing tests stay green. Add the tests enumerated above.
- One PR targeting `feature/workflow-engine`.
- Use `git pull` (merge), NOT `git pull --rebase`.

## Acceptance — All Must Pass

```bash
pnpm --filter @aoagents/ao-workflow build
pnpm --filter @aoagents/ao-workflow test     # existing + new tests pass
pnpm typecheck                                # whole repo
```

Manual smoke (document in PR body):

```bash
# Synthesize a TS file with a function, cite it, run the resolver.
cat > /tmp/foo.ts <<'EOF'
export function shorten(url: string): string {
  return "abc1234";
}
EOF
node packages/workflow/dist/resolver/script.js 'foo.ts#shorten' \
  --artifacts-dir /tmp --workspace-path /tmp --step-id smoke
# Expect: { ok: true, ... }
```

The human will re-run the URL-shortener dogfood post-merge to confirm `tests` step passes.

## When Done

1. Verify all acceptance.
2. Commit: `feat(workflow): phase 3.10 — resolver supports code-symbol anchors`
3. Push.
4. PR: `gh pr create --base feature/workflow-engine --title 'feat(workflow): phase 3.10 — resolver supports code-symbol anchors'`
5. PR body: describe the bug (link to Run 5 dogfood failure), list files changed, paste the manual smoke output, confirm test count went up.

## Out of Scope

- AST-based parsing (use regex).
- Non-JS/TS languages (Python, Go, Rust, etc. — a future phase).
- Method-name disambiguation when two classes in the same file share a method name (edge case, our workflows don't hit it).
- The 4-zombie-session count from Run 5 (separate issue, Phase 3.11 candidate).
- Publishing `@aoagents/aow` to npm.
- Any file outside `packages/workflow/` and `docs/`.
