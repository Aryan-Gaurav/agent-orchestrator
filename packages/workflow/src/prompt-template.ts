// Prompt assembly helpers. Three pure string operations:
//   - renderPrompt: substitute {{inputs.X}} / {{outputs.Y}} placeholders.
//   - appendExecutionContract: append the AOW completion-detection footer.
//   - prependFeedback: prepend prior-attempt reviewer feedback.
//
// See docs/workflow-engine.md §4 for the contracts. No I/O lives here.

import { TemplateError } from "./errors.js";

const CITATION_CONTRACT_FOOTER = `=== CITATION CONTRACT ===

WRITING — add a citation only when an upstream fact drove a decision in
this section of your output.
  Format (markdown):   <!-- ref: <file>#<section> claim="..." -->
  Format (code/JSON):  // ref: <file>#<section> claim="..."

The "claim" is one short sentence — the load-bearing assertion you are
taking as given from the cited section. Not a summary; the specific
fact.

Cite ONE HOP BACK: cite the artifact you actually consumed, not the
original source of the fact. The chain is walked at read time, not
enumerated at write time.

DO NOT cite for context-only reading. Reading upstream for orientation
without lifting a specific claim → no citation.

READING — when you encounter a citation:
  - You do NOT need to open the cited file unless one of these holds:
      (a) the claim looks inconsistent with the surrounding output text
      (b) your task explicitly requires verifying the claim's current
          truth
      (c) the claim is load-bearing for your output (you're propagating
          it forward)

  - To resolve a citation, prefer the resolver script over plain file
    reads:
        node .ao/aow-ref "<file>#<section>"
        node .ao/aow-ref "<file>#<section>" --claim "<claim>"
    Returns JSON with the resolved section content and any outgoing
    citations from that section. Hop logs are recorded automatically.

  - If verification requires following the chain further upstream
    (e.g., hld.md cites design.md and you need the original source),
    make additional hops. The resolver works the same at every step.

  - HOP-DEPTH LIMIT — if the resolver response includes
    \`warnings: ["hop_depth_4"]\`, you have followed the chain more than
    4 levels deep on this step. STOP traversing further unless the next
    hop is genuinely required to complete your task. Add an
    "## Open question" block to your output noting:
        - How many hops you made
        - What you were trying to verify
        - Whether you reached a definitive answer
    Deep traversal usually means the workflow is too long, the step is
    doing too much, or the upstream docs aren't structured around the
    right boundaries — surfacing the depth lets a human reviewer decide
    whether to restructure.

PROPAGATION — if your output makes a decision that depends on a fact
inherited from upstream, copy the citation forward (one hop) onto your
own section. Do not re-cite the upstream's upstream.

ERROR HANDLING — if the resolver returns ok=false:
  - file_not_found / section_not_found: include an "## Open question"
    block in your output flagging the broken ref. Do not invent content
    to fill the gap.
  - claim_mismatch: same — flag it explicitly. Upstream may have
    changed in a way that breaks your task.
=== END CITATION CONTRACT ===`;

export interface RenderVars {
  inputs: Record<string, string>;
  outputs: Record<string, string>;
}

// Matches `{{ inputs.foo }}` and `{{outputs.bar}}`. Whitespace around the
// expression is tolerated; the schema validator uses the same shape.
const TEMPLATE_VAR_RE =
  /\{\{\s*(inputs|outputs)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

// Catch curly-brace expressions that *look* like placeholders but reference an
// unknown namespace — better to throw than silently render a broken prompt.
const SUSPECT_VAR_RE = /\{\{\s*[^{}]+\s*\}\}/g;

export function renderPrompt(template: string, vars: RenderVars): string {
  const replaced = template.replace(TEMPLATE_VAR_RE, (_match, ns: string, name: string) => {
    const bag = ns === "inputs" ? vars.inputs : vars.outputs;
    const value = bag[name];
    if (value === undefined) {
      throw new TemplateError(`{{${ns}.${name}}}`);
    }
    return value;
  });

  // After substitution, any remaining `{{...}}` that still matches the suspect
  // pattern is an unsupported placeholder (e.g. {{env.X}}). Bail loudly so the
  // user notices instead of shipping a prompt with literal braces.
  const leftover = replaced.match(SUSPECT_VAR_RE);
  if (leftover) {
    for (const raw of leftover) {
      // Idempotency: if the placeholder was already substituted to a value that
      // happens to contain `{{...}}`, we can't easily tell. The conservative
      // choice is to throw on any leftover — callers should not produce values
      // that include double braces.
      throw new TemplateError(raw);
    }
  }
  return replaced;
}

export interface ExecutionContractOutput {
  name: string;
  path: string;
}

export function appendExecutionContract(
  prompt: string,
  outputs: Record<string, string>,
): string {
  const entries = Object.entries(outputs);
  const lines = entries.length === 0
    ? ["   (no declared outputs)"]
    : entries.map(([name, path]) => `   - ${name}: ${path}`);

  const footer = [
    "",
    "=== AOW EXECUTION CONTRACT ===",
    "When you are done with this task:",
    "1. Ensure these files exist at the exact paths shown:",
    ...lines,
    "2. Do NOT commit or push.",
    "3. Stop working — do not start additional tasks.",
    "=== END CONTRACT ===",
  ].join("\n");

  // Use a trailing newline before the footer so the contract is visually
  // separated even if the prompt ends without one.
  const separator = prompt.endsWith("\n") ? "" : "\n";
  return `${prompt}${separator}${footer}\n\n${CITATION_CONTRACT_FOOTER}\n`;
}

export function prependFeedback(prompt: string, feedback: string): string {
  const header = [
    "=== PRIOR ATTEMPT FEEDBACK ===",
    "Previous attempt was rejected. Reviewer said:",
    indentAsQuote(feedback),
    "",
    "Please revise and address this feedback. Read the prior output as the",
    "starting point — do NOT throw it away.",
    "=== END FEEDBACK ===",
    "",
  ].join("\n");

  return `${header}${prompt}`;
}

function indentAsQuote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}
