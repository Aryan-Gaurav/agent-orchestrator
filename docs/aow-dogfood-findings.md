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

