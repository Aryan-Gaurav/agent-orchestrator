# `aow` Dogfood Findings — Phase 3.7

**Fixture:** `~/aow-test-url-shortener/` — 4-step workflow (design → hld → impl → tests) producing a consistent-hashing URL shortener.
**Date:** 2026-05-22
**aow version:** Phase 3.6 (commits `9105dd07`, `ce1563ce`)

---

## Run summary — first attempt

| Step | Attempts | Wall time | Tokens (approx) | First-pass success | Citation issues | Manual edits needed |
|------|---------:|----------:|----------------:|--------------------|-----------------|---------------------|
| design | 1 | 80s | ~15k | ❌ | 11 errors, 1 warning | — (run aborted) |
| hld | 0 | — | — | — | — | — |
| impl | 0 | — | — | — | — | — |
| tests | 0 | — | — | — | — | — |

**Outcome:** Run failed at step 1 (design). Engine correctly rejected the agent output via citation linter. No revision loop fired — run was marked `failed`, not `awaiting_revision`. Downstream steps never started.

---

## What worked

- **Daemon auto-start refused gracefully** when `ao` wasn't on PATH. Clear error message pointed to the install command.
- **Manual daemon start** (`node packages/ao/bin/ao.js start --no-dashboard` from the fixture dir) registered the URL-shortener project correctly. `running.json` showed `projects: ["aow-test-url-shortener_aa35433bbb"]`.
- **`aow run` from a registered project** spawned correctly. Bootstrap was a no-op (yaml already existed). `ust-1` session came up in tmux in seconds, agent past trust prompt and actively working.
- **Plugin resolution** via the workflow package's `node_modules` worked first-pass — no "Runtime plugin 'tmux' not found" this time (fixed in `ce1563ce`).
- **Citation linter ran end-to-end** as designed. The contract is enforced; an agent that misuses citations cannot smuggle work past the gate.
- **Engine completion detection** worked. The `design` step was marked complete (outputs existed) before the linter rejected the citations, and the engine wrote a full `state.json` with input/output hashes for diagnosis.

---

## What broke

### Blocker #1 — Citation contract is path-fragile (engine bug, not agent bug)

**Severity:** blocker. Will hit any workflow with `inputs:` paths outside the artifacts/workspace tree.

**What happened:**
- The workflow declares `inputs.requirements: ../requirements.md` (file lives at `~/aow-test-url-shortener/requirements.md`; artifacts dir is `~/aow-test-url-shortener/artifacts/`).
- The prompt instructs the agent to cite as `<!-- ref: requirements.md#section claim="..." -->`.
- The agent obeyed: it wrote 11 such citations referencing `requirements.md`.
- The citation linter ran the resolver script against each citation. The resolver looks up `requirements.md` relative to `workspacePath` (the repo root) and fails 11 times with `File not found: requirements.md`. The file IS there — but the resolver doesn't consult the workflow's `inputs:` mapping to know which alias maps to which path.

**Root cause:** The resolver (`packages/workflow/src/resolver/script.ts`) treats citation file paths as raw filesystem paths to be resolved relative to a fixed root. It is not `inputs`-aware. Workflows where the input file is referenced by name in the prompt (the natural way to write a prompt) will always fail the lint.

**Workaround options:**
1. Author writes `<!-- ref: ../requirements.md ... -->` — exposes the directory structure, ugly, fragile.
2. Author re-paths everything to relative-from-artifacts — wrong layer, brittle.
3. Engine pre-stages a copy/symlink of every `inputs:` file under `artifacts/inputs/<name>` before the agent runs, and the citation contract resolves `<name>` against that. **This is the correct fix** but it's a non-trivial engine change.

**Real fix:** The resolver should consult the step's `inputs:` map. A citation `requirements.md` should be looked up as: (a) does the step have an input named `requirements` (or with basename `requirements.md`)? (b) if yes, resolve against that input's absolute path. (c) if no, fall back to filesystem resolution.

This affects every dogfood workflow with cross-directory inputs. It is the difference between "workflow engine works on toy examples" and "workflow engine works on real repos."

### Blocker #2 — No revision loop fired despite `citations_invalid` failure mode

**Severity:** blocker for the dogfood UX. Without revision, every agent step is one-shot.

**What happened:**
- `state.json` recorded `steps.design.failure_reason = "citations_invalid"`.
- Engine logged the failure, marked the run `failed`, did NOT re-spawn the agent with the lint errors as feedback.
- `max_revisions` (default 3) was never consulted.

**Expected:** per `docs/workflow-engine.md` §4 (Revision Loop Cap) and §17 (Citation Validation), a `citations_invalid` failure should trigger a re-spawn with the failure report injected as feedback, up to `max_revisions` times.

**Actual:** Single attempt; failure terminates the run.

**Where to look:** `packages/workflow/src/engine/step-runner.ts` (or wherever per-step result handling lives) — the rejection path for `citations_invalid` isn't wired to the revision loop.

### Annoyance #1 — Lint errors not surfaced to user

**Severity:** annoying. Forces the user to invoke the linter manually to see what failed.

`aow run` logged `error [design] citation lint failed: 11 error(s)` — but the 11 specific errors are nowhere in the log, nowhere in `state.json`. To see them I had to write a Node one-liner that re-imported `lintStepCitations` with the right args.

**Fix:** when the engine catches a `citations_invalid` rejection, persist the `LintReport` (errors + warnings) into `state.json` under the failed attempt, and print at least the first 5 errors to stderr.

### Annoyance #2 — Hops warning is silent and limit is undocumented

**Severity:** nit. Surfaced 1 warning: `Step has 11 hops in ref-hops.jsonl (limit 4)`. The warning never appeared in `aow run` output (only when I invoked the linter directly). The limit "4" isn't mentioned in the workflow.yaml schema, the agent prompt, or any visible doc.

**Fix:** document the hops cap in `docs/aow-guide.md` §3 (Writing a workflow) and `docs/workflow-engine.md` §17. Surface the warning in `aow run` output.

---

## Friction points

- **Daemon registration is a hidden gotcha.** `aow run` from a fresh dir works (smoke test proved it). But `aow run` from a dir whose project is registered but NOT polled by the running daemon fails silently — the daemon-check passes (daemon exists) but `ao spawn` refuses internally. I had to stop+restart the daemon from the fixture dir. There is no error message that says "register this project with the running daemon."
- **`tmux ls`** is the only way to see which AO sessions belong to this run. `aow status` showed nothing useful while the run was active.
- **No `aow logs <step>`** command. To inspect an agent's terminal I had to `tmux attach -t ust-1` (which I'm trained on, but a new user wouldn't be).
- **Run-state directory location varies between cwd and AO project workspace.** The `state.json` lived under `~/aow-test-url-shortener/.workflow-state/runs/.../`, but the agent's worktree was under `~/.agent-orchestrator/projects/aow-test-url-shortener_aa35433bbb/worktrees/ust-1/`. The artifacts ended up at `~/aow-test-url-shortener/artifacts/design.md` — outside the agent's worktree. That seam is non-obvious and made me re-check the workflow.yaml twice.

---

## The verdict

**Not shippable to external dogfood users yet.** The citation-contract path-resolution bug (blocker #1) is hit by every workflow that references files outside its artifacts dir, which is most realistic workflows. The missing revision loop (blocker #2) means the value prop of "agent self-corrects against the linter" is currently absent — every lint failure is a hard stop.

**However:** the core orchestration loop works. Bootstrap, daemon-check, plugin resolution, project resolution, session spawn, output verification, completion detection, lint enforcement — all functional end-to-end. The bugs above are localized to the citation/revision layer (§16-17 of the design doc), not the underlying engine.

Estimated work to ship-ready: blocker #1 ~half day in resolver + engine; blocker #2 ~1-2 hours in step-runner; both annoyances 1-2 hours. Call it a focused day's work for one engineer.

---

## Follow-up issues to file

1. `[engine] resolver script must consult step inputs: map for citation path resolution` (blocker #1)
2. `[engine] citations_invalid should trigger revision loop, not abort run` (blocker #2)
3. `[engine] persist LintReport into state.json and surface first N errors in aow run output` (annoyance #1)
4. `[docs] document hops cap; surface warning in aow run output` (annoyance #2)
5. `[engine] aow status should list active agent sessions for the current run` (friction)
6. `[cli] add aow logs <step> as a shortcut for tmux attach to the step's session` (friction)

---

## Run summary — second attempt (post-workaround re-run)

Workaround applied: copied `requirements.md` into `artifacts/` so the resolver could find it.

**Outcome:** Run failed before any step started.

### Blocker #3 — Engine reuses branch names; old worktree blocks re-spawn

**Severity:** blocker for any re-run scenario.

**What happened:**
- I wiped `~/aow-test-url-shortener/.workflow-state/` and re-ran `aow run workflow.yaml`.
- Engine generated branch name `aow-url-shortener-build-design-1` for the new `design` attempt #1.
- `git worktree add` failed: branch is already in use by the prior failed run's worktree at `worktrees/ust-1`.
- Run was marked `failed` with empty failed-step list (the spawn error fires before the step gets a chance to enter the `attempts` array — so `failed: []` in the result).

**Root cause:** Engine doesn't know about (and doesn't clean up) AO session/worktree state owned by the previous run. The `.workflow-state/` wipe only clears engine-side bookkeeping; the AO project still has dangling sessions and worktrees from the prior run.

**Workaround:** `node packages/ao/bin/ao.js session kill ust-1` (with the `session` subcommand, not the `kill` command — `kill` doesn't exist as a top-level command, which is a separate UX issue). After that the worktree is cleaned up and the branch is released.

**Real fix:** when the engine starts a fresh run (no state.json), it should:
1. Detect any existing AO sessions whose branch name matches the workflow's expected branch pattern.
2. Either reclaim them, kill them with `auto_cleanup` reason, or error with `aow clean --hard` as the recovery hint.

Alternatively, the branch name should incorporate the run-id so collisions are impossible across runs.

### Annoyance #3 — `aow run` exit message says `failed: []` when spawn fails

The run-level result shows `status: "failed", failed: []`. The empty `failed` array misleads — a step's spawn failure isn't recorded in the per-step state because the step never made it past the spawn boundary. User has to read the `error` log line above to know what actually failed.

**Fix:** spawn errors should populate the failed array with the step id and a clear `failure_reason: "spawn_failed"`.

### Annoyance #4 — `ao kill` doesn't exist; user must discover `ao session kill`

**Severity:** nit (an AO CLI issue, not aow). But for aow users debugging dogfood, this is the obstacle they'll hit first.

`ao --help` advertises `session  Session management (ls, kill, cleanup, restore, claim-pr)` but the `session` subcommand isn't intuitive when you're trying to kill ONE thing quickly. `ao kill <session-id>` would be the obvious shortcut.

---

## Sanity-check via direct linter invocation

To prove the citation-resolution theory I ran:

```javascript
import { lintStepCitations } from '@aoagents/ao-workflow/dist/citation-linter.js';
const r = await lintStepCitations({
  artifactsDir: '/Users/aryangaurav/aow-test-url-shortener/artifacts',
  workspacePath: '/Users/aryangaurav/aow-test-url-shortener',
  stepId: 'design',
  outputFiles: ['.../artifacts/design.md'],
  trackedInputCount: 1,
  resolverScriptPath: '.../packages/workflow/dist/resolver/script.js',
});
```

**Before workaround:** 11 errors, all `File not found: requirements.md` + 1 warning `Step has 11 hops in ref-hops.jsonl (limit 4)`.

**After staging `requirements.md` into `artifacts/`:** 1 error (`Claim did not match section "out-of-scope" in requirements.md`) + 7 warnings. The single remaining error is a slug-mismatch (agent cited `out-of-scope`, heading is `Out of scope` → slug becomes `out-of-scope` either way? need to investigate) — but it's a 10× reduction. Hypothesis confirmed: the resolver IS the blocker.

### Annoyance #5 — `citation-resolver-script.js` doesn't exist at the expected path

While reproducing the lint manually, I first hit `Cannot find module '...dist/citation-resolver-script.js'`. The actual script is at `dist/resolver/script.js`. The error originates from the linter trying to spawn the resolver subprocess with the wrong filename embedded.

Looking at the code: the linter takes `resolverScriptPath` as input, so this isn't a hard-coded bug; the caller (engine) must be passing the right path. The error I hit was from an incorrect default I guessed when calling the linter directly. **Not a real bug** — withdrawing as a finding. (Recording the diagnostic to spare the next person.)

---

## Updated verdict

Three blockers, five annoyances surfaced from two run attempts of one realistic workflow. The blockers are concentrated in the **citation/revision/cleanup** layer; the core orchestration is sound. The engine demonstrably:

- Spawns agents into isolated worktrees ✓
- Detects completion via the two-check contract ✓
- Verifies output files exist and hashes them ✓
- Runs the citation linter as a gate ✓
- Persists rich state for post-mortem ✓

But none of the workflow-level guarantees the design promises (revision loops, cross-run cleanup, inputs-aware citation resolution) work yet on a real workflow.

**Recommendation:** before extending the engine or doing more dogfood, fix the three blockers in this order: #1 (resolver inputs-awareness), #2 (revision loop), #3 (cross-run cleanup). They are independent and small (estimated ~1 day total).

---

## Run summary — third attempt (fresh agent run, with workaround)

State wiped, old session killed, `requirements.md` still staged in `artifacts/`. Goal: confirm blocker #1's workaround actually unblocks the design step end-to-end, and surface any *new* issues.

**Outcome:** Run failed at step 1 (design). One lint error, citations_invalid. Engine aborted, no revision.

### Confirmed: blocker #1 workaround works partially

A fresh claude-code instance, never having seen the prior run, produced design.md with 11 citations. The linter found only **1 error** this time (down from 11). All 10 file-found citations passed. The workaround (staging `requirements.md` into `artifacts/`) does unblock the path-resolution failure.

### New finding — slug-mismatch on headings

The remaining error:
```
Claim did not match section "out-of-scope" in requirements.md
```

`requirements.md` has the heading `## Out of scope`. The agent generated the slug `out-of-scope` (lowercase, dashes — the most common Markdown slug convention, used by GitHub and most static-site generators). The linter's resolver evidently uses a different slug derivation.

**To investigate:** what slug does the resolver expect? Looking at `packages/workflow/src/resolver/script.ts` would tell us. If the resolver expects `out_of_scope` or `outOfScope` or literal `Out of scope`, it diverges from every Markdown convention agents would naturally use.

**Likely fix:** the resolver should accept multiple slug forms (GitHub-style at minimum: lowercase, spaces → dashes, strip punctuation). Or the prompt should document the exact slug rule.

### Confirmed: blocker #2 still applies

The 1 lint error caused an immediate run abort. No second attempt, no feedback injection. `max_revisions: 3` is in the schema but never consulted.

---

## Verdict (final, after 3 runs)

Three runs, three failures, all at step 1 (design). Run-by-run failure mode:

| Run | Outcome | Failure surface |
|-----|---------|----------------|
| 1   | failed | 11 lint errors (file-not-found, blocker #1) |
| 2   | failed | spawn — branch/worktree reuse (blocker #3) |
| 3   | failed | 1 lint error (slug-mismatch, narrow case of blocker #1's friend) + no revision (blocker #2) |

**The pattern is clear.** The orchestration substrate works; the gate enforcement is too strict for real workflows. Specifically:

- Path resolution doesn't know about `inputs:` aliasing → fails with cross-directory inputs.
- Slug derivation doesn't match conventional Markdown slug rules → fails on Heading-with-spaces.
- A single gate failure aborts instead of looping → the revision-loop value prop is currently absent.

Each failure is one tractable bugfix. None require redesign. Stopping the dogfood here is correct: more runs would just re-confirm the same three findings.

### Fixes to ship before next dogfood (priority order)

1. **Resolver: inputs-awareness.** Citation paths should resolve via the step's `inputs:` map first, falling back to filesystem. ~half day.
2. **Resolver: slug compatibility.** Accept GitHub-style slugs (the conventional default). Document the rule. ~1 hour.
3. **Engine: citations_invalid → revision.** Route lint failures into the existing `max_revisions` loop with `LintReport.errors` injected as feedback. ~2 hours.
4. **Engine: persist `LintReport` into state.json.** ~1 hour.
5. **Engine: cross-run worktree cleanup.** Detect dangling sessions on fresh-run startup and reclaim or error with a recovery hint. ~half day.

Combined: ~1.5 engineer-days. After that, re-run dogfood and expect to surface a *different* class of bugs (probably in `hld` or `impl` stages).


---

## Run 4 — Re-dogfood post Phase 3.8 (2026-05-22)

After PR #14 landed all 5 fixes, ran the URL-shortener workflow twice.

### First attempt (pre-rebuild — failure mode: stale dist)
- `aow run workflow.yaml` invoked the binary, which loaded compiled JS from `packages/workflow/dist/`. The merge had not been rebuilt.
- Symptoms identical to Run 3: 10 lint errors, no revision loop, no lint_report in state, run failed at design attempt 1.
- **Finding 6 (process):** `aow` has no build-freshness check. The user has to remember to `pnpm --filter @aoagents/ao-workflow build` after pulling. The Phase 3.8 PR was effectively invisible until rebuilt.
- **Suggested fix:** either (a) `aow` boot prints a warning when `dist/` mtime < any `src/**/*.ts` mtime, or (b) the `aow` bin wrapper invokes the build step lazily, or (c) ship a published binary so users never hit this. Lowest-risk is (a).

### Second attempt (post-rebuild)
Run id: `wf-url-shortener-build-20260522T033437`. All 5 Phase 3.8 fixes activated.

| Fix | Activated? | Evidence |
|---|---|---|
| 1 — Resolver consults `inputs:` map | ✅ | Lint errors dropped from 10 → 1 (only `out-of-scope` slug mismatched, not all paths) |
| 2 — GitHub-style slug acceptance | ⚠️ partial | `out-of-scope` slug still failed once on attempt 1, but agent retry produced a passing version |
| 3 — Revision loop on `citations_invalid` | ✅ | Log: `revising (attempt 1/3)` → `attempt=2` → `completed` |
| 4 — `lint_report` persisted to state.json | ✅ | Stored on `steps.design.history[0].lint_report` (the *failed* attempt), not on `current_attempt` of the passing attempt. The status-check script was looking in the wrong field; the data is there. |
| 5 — Run-id suffixed branch names | ✅ | Branch: `aow-url-shortener-build-design-1-wf-url-shortener-build-20260522T033437` |

Design step completed in 2 attempts (~110s). Then a NEW failure appeared at hld.

### Finding 7 — `hld` agent declared dead 88ms after spawn (spawn race)

**Symptom**
```
03:36:30.565  step  [hld] spawning agent=claude-code branch=aow-url-shortener-build-hld-1-...
03:36:30.653  error [hld] Session ust-6 reached terminal status 'spawning' (activity=exited) before producing outputs
run: failed
```
The gap between `started_at` and `completed_at` in state.json is **88ms**. claude-code's tmux session takes longer than that to attach and register its first activity. The engine sees `status=spawning, activity=exited` (because no PID has reported yet) and treats that as terminal.

**Smoking-gun evidence:** the abandoned ust-6 session continued running anyway and **successfully produced `hld.md` (244 lines)** after the engine had already marked the step failed. The agent was fine; the engine gave up too early.

**Root cause (hypothesis)**
The completion-detector in `packages/workflow/src/engine/...` polls AO `LifecycleManager` for session status and checks for terminal states. The check is something like "if `status` is in a terminal set (`spawning`+`exited`?) and outputs haven't been produced → fail." But `spawning` + `activity=exited` is the **normal state for the first ~100–500ms** of every claude-code spawn before the wrapper has set up its PTY and the activity log.

Two sub-options:
- 7a: `spawning` should be a **transient** state, not eligible for terminal classification regardless of activity. Only `idle/working/done` etc. count as "agent attached."
- 7b: Apply a minimum-spawn-grace-period (say, 30s) before declaring exit on any newly-spawned session.

7a is the correct fix; 7b is a band-aid. Likely both: the grace period prevents catastrophic regressions if 7a misclassifies something.

**Why design didn't hit this:** likely lucky timing — design's first poll happened to land after claude-code attached, hld's didn't.

### Finding 8 — Revision loop preserves prior failed branch, agents pile up

Five `ust-N` sessions exist after the run: ust-3 (stale from prior run), ust-4 (design attempt 1, failed), ust-5 (design attempt 2, passed), ust-6 (hld attempt 1, abandoned), ust-orchestrator.

Each revision attempt spawns a fresh session on a fresh branch (`-design-1-...`, `-design-2-...`). The prior attempt's session is never killed — it's just orphaned in tmux. After 3 revisions per step × 4 steps = potentially 12 zombie sessions per run.

**Suggested fix:** when starting attempt N+1, kill the session for attempt N (its branch + worktree is preserved for forensics, but the tmux session is freed). This is a 1-line addition near the revision-loop spawn site.

### Verdict for Phase 3.9

Phase 3.8 worked. The engine now does revision loops, surfaces lint errors, and uses collision-free branches. The remaining blockers are different:

1. **Spawn-race (Finding 7)** — blocks every multi-step workflow because step 2+ will hit it intermittently. Highest priority.
2. **Build-freshness UX (Finding 6)** — silent failure mode for any user pulling fixes. High priority.
3. **Zombie sessions (Finding 8)** — quality-of-life, not a blocker. Medium priority.

Estimated effort: 3 + 6 + 8 = ~1 engineer-day total. Then another dogfood to confirm.
---

## Run 5 — Post Phase 3.9 (2026-05-22)

Run id: `wf-url-shortener-build-20260522T044835`. All 5 Phase 3.8 + all 3 Phase 3.9 fixes active.

### Outcome

| Step | Status | Attempts | Notes |
|---|---|---|---|
| design | ✅ completed | 2 | revised once on `out-of-scope` slug mismatch |
| hld | ✅ completed | 3 | revised twice on `claim_mismatch` errors |
| impl | ✅ completed | 2 | revised once; produced 7 source files |
| tests | ❌ failed | 3 | exhausted max_revisions on `section_not_found` for `.ts` files |

The agent produced 3 vitest files (`HashRing.test.ts`, `Shortener.test.ts`, `e2e.test.ts`) plus a working URL shortener. Manual verification: `pnpm test` reports **10/10 tests passing**, server smoke-tested with real HTTP (POST /shorten → 201 with code, GET /:code → 302 redirect, GET /unknown → 404).

### Finding 9 — Resolver doesn't understand code-symbol anchors

The `tests` step failed with errors like:

```
[section_not_found] __tests__/Shortener.test.ts:src/Shortener.ts#shorten — Section "shorten" not found in src/Shortener.ts
[section_not_found] __tests__/HashRing.test.ts:src/HashRing.ts#addShard — Section "addShard" not found in src/HashRing.ts
[section_not_found] __tests__/HashRing.test.ts:src/HashRing.ts#shardForKey — Section "shardForKey" not found in src/HashRing.ts
```

The agent's citations were correct (`shorten`, `addShard`, `shardForKey` are all real functions in those files). The resolver's `extractSections` (`packages/workflow/src/resolver/parse.ts:49`) only matches Markdown `^(#{1,6})\s+` headings, so source files have zero sections and every code-symbol anchor fails.

**Smoking gun:** the same agent's citations against `hld.md#httpserver`, `requirements.md#functional-requirements`, `design.md#id-generation-and-collisions` all resolved fine — because those are Markdown.

**Fix path (Phase 3.10):** add an `extractCodeSections` regex-based extractor for `.ts`/`.tsx`/`.js`/`.jsx`/`.mts`/`.cts`/`.mjs`/`.cjs` that emits "sections" for `function`/`class`/`const`/`interface`/`type`/`enum`/method declarations. Slug rule unchanged. Markdown path unchanged. Other languages fall through to existing "no sections" behavior. Brief: `.workflow-bootstrap/phase-3.10-prompt.md`.

### Finding 10 — Zombie sessions persist despite Fix 3 (Phase 3.9)

End of run: 4 active `ust-N` tmux sessions (ust-8, ust-11, ust-13, ust-16) plus orchestrator. Fix 3 from Phase 3.9 was supposed to kill the prior attempt's session before spawning the next one. Either it's not firing for the *final-failed* attempt (only inter-revision kills), or the kill is fire-and-forget and the session doesn't actually terminate.

Lower-priority than Finding 9 (cosmetic, not blocking). Triage in Phase 3.11.

### Verdict for Phase 3.10

The engine now runs a 4-step real software workflow to **75% completion automatically**, with a working build at the end. The remaining failure is a single resolver limitation (code-symbol anchors) — a contained ~half-day fix. Post-fix, the workflow should reach 100%.

Estimated effort: 4 hours implementation + 1 hour docs + 1 hour re-dogfood. Brief ships as `.workflow-bootstrap/phase-3.10-prompt.md`.
---

## Run 6 — Post Phase 3.10 (2026-05-23)

Run id: `wf-url-shortener-build-20260522T222945`. All Phase 3.8/3.9/3.10 fixes active.

### Outcome

| Step | Status | Attempts | Notes |
|---|---|---|---|
| design | ✅ completed | 1 | first-try pass — no lint failures |
| hld | ✅ completed | 2 | revised once |
| impl | ❌ failed | 3 | same 4 `claim_mismatch` errors every attempt |
| tests | — pending | 0 | never reached |

**Phase 3.10 verification status: unverified.** The tests step (the one Phase 3.10 targeted) never ran because impl failed first on a different, pre-existing issue.

### Finding 11 — `matchClaim` requires 100% token coverage; no stemming

The 4 errors that killed `impl`:

```
[claim_mismatch] src/Shortener.ts:hld.md#shortener
[claim_mismatch] src/HashRing.ts:hld.md#hashring
[claim_mismatch] src/Shortener.ts:design.md#shortcode-encoding
[claim_mismatch] src/Shortener.ts:design.md#id-generation-and-collisions
```

These are NOT `section_not_found` (Phase 3.10 territory) — they're `claim_mismatch`. The section was found; the claim text didn't fuzzy-match it.

**Reproduction** (deterministic):

Section body (hld.md `### Shortener`, real text):

> Orchestrates the write path: generate a random 7-char base62 code, ask the ring for the owning shard, attempt setIfAbsent, retry on collision up to 5 times. Also owns the read path: ask the ring for the shard, get the URL.

Agent's claim (from `src/Shortener.ts`):

> Shortener generates random 7-char base62 code, routes via ring, setIfAbsent with retry up to 5x; resolve does ring lookup + get.

`matchClaim` returns `{ found: false, confidence: 0 }`. Why:

- `parse.ts:117 matchClaim` tokenizes the claim, filters tokens to length ≥4 and non-stopword.
- Tokens include `generates`, `routes`, `resolve`, `lookup`.
- Section body has `generate`, `ask`, `attempt`, `get` — same meaning, different surface form.
- The matcher rule at `parse.ts:136`: `if (matched === tokens.length && confidence >= 0.5)`. **Requires 100% of tokens to appear literally.** `generates` ≠ `generate` (no stem), `routes` ≠ `ring/shard` (no synonym), `lookup` not in body (semantic but not lexical).
- One missing token → confidence falls below threshold → `found: false`.

This is the fundamental problem: the citation contract assumes the agent will quote the upstream text. The agent naturally **paraphrases** when explaining what the code does. Paraphrase + strict-token-match = guaranteed mismatch.

**Why earlier runs worked.** Past dogfood runs used claims that *quoted* requirements.md verbatim (e.g., "302-redirects to the original URL" — a direct quote). hld→impl naturally paraphrases more, because the agent is summarizing a design decision into a `// ref:` comment, not echoing it.

**Suggested fixes (priority order):**

1. **Tier-3 partial-match acceptance.** If `matched / tokens.length >= 0.6` (down from 1.0 implicit threshold), return `{ found: true, match_kind: "token_overlap", confidence }`. Today's 100% threshold rejects realistic paraphrase. The existing soft-warning at confidence ≥0.7 (`parse.ts` token_overlap path) already implies partial match is acceptable upstream — make it the success path.
2. **Stemming.** Basic suffix-strip (`s`, `es`, `ed`, `ing`) so `generates` and `generate` collapse. Adds ~10 lines. Catches the most common false-mismatches.
3. **Document the contract.** `docs/aow-guide.md` §3 should state plainly: "claims must contain ≥60% of the load-bearing tokens (≥4 chars, non-stopword) from the cited section." Today this is implicit and the agent doesn't know the rule.

Without one of these, every realistic workflow will hit this on the impl or tests step — exactly what Run 6 shows.

### Finding 10 follow-up — zombie sessions persist (still)

End of Run 6: 3 active `ust` sessions (ust-17, ust-19, ust-22) + orchestrator. Phase 3.9 Fix 3 should have killed prior attempts; it didn't fully. Same finding as Run 5. Confirmed reproducible, not a transient.

### Findings 7 + 1–5 status (regression check)

- Spawn race (Finding 7, Phase 3.9): ✅ no spawn-race failures this run.
- Revision loop (Fix 3, Phase 3.8): ✅ fired correctly on hld and impl.
- Lint visibility (Fix 4, Phase 3.8): ✅ all 4 errors printed to stderr with claim text.
- Run-id branch suffixes (Fix 5, Phase 3.8): ✅ branches like `aow-url-shortener-build-impl-3-wf-...`.
- Code-symbol anchors (Phase 3.10): ⚠️ **untested** — never reached tests step.

### Verdict for Phase 3.11

Phase 3.10 must be re-verified in a future run, after the `claim_mismatch` blocker is removed. Two clean paths:

- **Phase 3.11a (recommended):** loosen `matchClaim` to accept ≥60% token overlap. ~30 min implementation + tests. Re-dogfood immediately verifies both 3.10 and 3.11.
- **Phase 3.11b (broader):** stemming + partial-match + a `--claim-strict` flag for workflows that want today's behavior. ~3 hours.

Recommendation: ship 3.11a now, surface 3.11b only if 3.11a still produces too many false-passes on real workflows. Brief target: `.workflow-bootstrap/phase-3.11-prompt.md`.
