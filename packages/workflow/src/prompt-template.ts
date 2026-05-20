// Prompt assembly helpers. Three pure string operations:
//   - renderPrompt: substitute {{inputs.X}} / {{outputs.Y}} placeholders.
//   - appendExecutionContract: append the AOW completion-detection footer.
//   - prependFeedback: prepend prior-attempt reviewer feedback.
//
// See docs/workflow-engine.md §4 for the contracts. No I/O lives here.

import { TemplateError } from "./errors.js";

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
  return `${prompt}${separator}${footer}\n`;
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
