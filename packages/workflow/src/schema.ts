import { parse as parseYaml, YAMLParseError } from "yaml";
import { z } from "zod";

import {
  WorkflowCycleError,
  WorkflowValidationError,
  type ValidationIssue,
} from "./errors.js";
import type {
  AgentStep,
  ApprovalStep,
  StepID,
  WorkflowDefinition,
  WorkflowStep,
} from "./types.js";

const stepIdSchema = z
  .string()
  .min(1, "step id must be a non-empty string")
  .regex(
    /^[a-zA-Z_][a-zA-Z0-9_-]*$/,
    "step id must start with a letter or underscore and contain only letters, digits, underscores, or hyphens",
  );

const artifactNameSchema = z
  .string()
  .min(1, "artifact name must be a non-empty string")
  .regex(
    /^[a-zA-Z_][a-zA-Z0-9_]*$/,
    "artifact name must be a valid identifier (letters, digits, underscores)",
  );

const workflowInputSchema = z.object({
  name: artifactNameSchema,
  path: z.string().min(1),
});

const agentStepSchema = z.object({
  id: stepIdSchema,
  type: z.literal("agent"),
  depends_on: z.array(z.string()).optional(),
  agent: z.string().min(1),
  prompt: z.string().min(1),
  inputs: z.record(artifactNameSchema, z.string().min(1)).optional(),
  outputs: z.record(artifactNameSchema, z.string().min(1)),
  timeout_minutes: z.number().positive().optional(),
  branch: z.string().min(1).optional(),
  max_revisions: z.number().int().positive().optional(),
});

const approvalStepSchema = z.object({
  id: stepIdSchema,
  type: z.literal("human_approval"),
  depends_on: z.array(z.string()).optional(),
  message: z.string().min(1),
  on_reject: z.string().min(1),
  max_revisions: z.number().int().positive().optional(),
});

const stepSchema = z.discriminatedUnion("type", [
  agentStepSchema,
  approvalStepSchema,
]);

const workflowSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  artifacts_dir: z.string().min(1),
  project_id: z.string().min(1),
  inputs: z.array(workflowInputSchema).optional(),
  steps: z.array(stepSchema).min(1, "workflow must define at least one step"),
});

// Captures patterns like `{{ inputs.foo }}` or `{{outputs.bar}}`. Other curly-
// brace forms are ignored here so user prompts can include literal `{{...}}`.
const TEMPLATE_VAR_RE = /\{\{\s*(inputs|outputs)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export function parseWorkflowDefinition(yamlText: string): WorkflowDefinition {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    const message =
      err instanceof YAMLParseError
        ? err.message
        : err instanceof Error
          ? err.message
          : "failed to parse YAML";
    throw new WorkflowValidationError(
      [{ path: "(root)", message: `Invalid YAML: ${message}` }],
      { cause: err instanceof Error ? err : undefined },
    );
  }

  if (raw === null || typeof raw !== "object") {
    throw new WorkflowValidationError([
      { path: "(root)", message: "Workflow document must be a YAML mapping" },
    ]);
  }

  const parsed = workflowSchema.safeParse(raw);
  if (!parsed.success) {
    throw new WorkflowValidationError(zodIssues(parsed.error));
  }

  const definition = parsed.data as WorkflowDefinition;
  const issues: ValidationIssue[] = [];

  validateUniqueStepIds(definition, issues);
  // If step IDs are not unique the rest of the cross-step checks would
  // surface confusing duplicate messages. Bail early in that case.
  if (issues.length > 0) {
    throw new WorkflowValidationError(issues);
  }

  const stepsById = new Map<StepID, WorkflowStep>(
    definition.steps.map((step) => [step.id, step]),
  );

  validateDependsOnRefs(definition, stepsById, issues);
  validateApprovalTargets(definition, stepsById, issues);

  if (issues.length > 0) {
    throw new WorkflowValidationError(issues);
  }

  // Cycle detection must run before reachability checks below.
  const cycle = detectCycle(definition);
  if (cycle) {
    throw new WorkflowCycleError(cycle);
  }

  validateApprovalUpstream(definition, stepsById, issues);
  validateTemplateVariables(definition, issues);
  validateInputNameCollisions(definition, issues);

  if (issues.length > 0) {
    throw new WorkflowValidationError(issues);
  }

  return definition;
}

function zodIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length === 0 ? "(root)" : issue.path.join("."),
    message: issue.message,
  }));
}

function validateUniqueStepIds(
  definition: WorkflowDefinition,
  issues: ValidationIssue[],
): void {
  const seen = new Set<StepID>();
  definition.steps.forEach((step, index) => {
    if (seen.has(step.id)) {
      issues.push({
        path: `steps[${index}].id`,
        message: `duplicate step id "${step.id}"`,
      });
    } else {
      seen.add(step.id);
    }
  });
}

function validateDependsOnRefs(
  definition: WorkflowDefinition,
  stepsById: Map<StepID, WorkflowStep>,
  issues: ValidationIssue[],
): void {
  definition.steps.forEach((step, index) => {
    const deps = step.depends_on ?? [];
    deps.forEach((depId, depIndex) => {
      if (depId === step.id) {
        issues.push({
          path: `steps[${index}].depends_on[${depIndex}]`,
          message: `step "${step.id}" cannot depend on itself`,
        });
      } else if (!stepsById.has(depId)) {
        issues.push({
          path: `steps[${index}].depends_on[${depIndex}]`,
          message: `depends_on references unknown step "${depId}"`,
        });
      }
    });
  });
}

function validateApprovalTargets(
  definition: WorkflowDefinition,
  stepsById: Map<StepID, WorkflowStep>,
  issues: ValidationIssue[],
): void {
  definition.steps.forEach((step, index) => {
    if (step.type !== "human_approval") return;
    if (!stepsById.has(step.on_reject)) {
      issues.push({
        path: `steps[${index}].on_reject`,
        message: `on_reject references unknown step "${step.on_reject}"`,
      });
    } else if (step.on_reject === step.id) {
      issues.push({
        path: `steps[${index}].on_reject`,
        message: `on_reject cannot point at the approval step itself`,
      });
    }
  });
}

function detectCycle(definition: WorkflowDefinition): string[] | null {
  const adjacency = new Map<StepID, StepID[]>();
  for (const step of definition.steps) {
    adjacency.set(step.id, step.depends_on ?? []);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<StepID, number>();
  for (const id of adjacency.keys()) color.set(id, WHITE);

  const stack: StepID[] = [];

  function visit(node: StepID): string[] | null {
    color.set(node, GRAY);
    stack.push(node);
    const neighbors = adjacency.get(node) ?? [];
    for (const next of neighbors) {
      const next_color = color.get(next) ?? WHITE;
      if (next_color === GRAY) {
        const cycleStart = stack.indexOf(next);
        const cycle = stack.slice(cycleStart);
        cycle.push(next);
        return cycle;
      }
      if (next_color === WHITE) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(node, BLACK);
    return null;
  }

  for (const id of adjacency.keys()) {
    if ((color.get(id) ?? WHITE) === WHITE) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

function collectUpstream(
  startId: StepID,
  definition: WorkflowDefinition,
): Set<StepID> {
  const adjacency = new Map<StepID, StepID[]>();
  for (const step of definition.steps) {
    adjacency.set(step.id, step.depends_on ?? []);
  }
  const visited = new Set<StepID>();
  const queue: StepID[] = [...(adjacency.get(startId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift() as StepID;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const dep of adjacency.get(id) ?? []) {
      if (!visited.has(dep)) queue.push(dep);
    }
  }
  return visited;
}

function validateApprovalUpstream(
  definition: WorkflowDefinition,
  stepsById: Map<StepID, WorkflowStep>,
  issues: ValidationIssue[],
): void {
  definition.steps.forEach((step, index) => {
    if (step.type !== "human_approval") return;
    if (!stepsById.has(step.on_reject)) return; // already flagged
    const upstream = collectUpstream(step.id, definition);
    if (!upstream.has(step.on_reject)) {
      issues.push({
        path: `steps[${index}].on_reject`,
        message: `on_reject target "${step.on_reject}" must be upstream of approval step "${step.id}" (reachable via depends_on)`,
      });
    }
  });
}

function validateTemplateVariables(
  definition: WorkflowDefinition,
  issues: ValidationIssue[],
): void {
  const workflowInputNames = new Set(
    (definition.inputs ?? []).map((input) => input.name),
  );
  definition.steps.forEach((step, index) => {
    if (step.type !== "agent") return;
    const agentStep: AgentStep = step;
    const localInputs = new Set(Object.keys(agentStep.inputs ?? {}));
    const outputs = new Set(Object.keys(agentStep.outputs));

    for (const match of agentStep.prompt.matchAll(TEMPLATE_VAR_RE)) {
      const namespace = match[1];
      const name = match[2];
      if (namespace === "inputs") {
        if (!localInputs.has(name) && !workflowInputNames.has(name)) {
          issues.push({
            path: `steps[${index}].prompt`,
            message: `template variable {{inputs.${name}}} is not declared in this step's inputs or workflow-level inputs`,
          });
        }
      } else if (namespace === "outputs") {
        if (!outputs.has(name)) {
          issues.push({
            path: `steps[${index}].prompt`,
            message: `template variable {{outputs.${name}}} is not declared in this step's outputs`,
          });
        }
      }
    }
  });
}

function validateInputNameCollisions(
  definition: WorkflowDefinition,
  issues: ValidationIssue[],
): void {
  const workflowInputNames = new Set(
    (definition.inputs ?? []).map((input) => input.name),
  );
  if (workflowInputNames.size === 0) return;
  definition.steps.forEach((step, index) => {
    if (step.type !== "agent") return;
    const localNames = Object.keys(step.inputs ?? {});
    for (const name of localNames) {
      if (workflowInputNames.has(name)) {
        issues.push({
          path: `steps[${index}].inputs.${name}`,
          message: `step-local input "${name}" collides with a workflow-level input of the same name`,
        });
      }
    }
  });
}

// Re-export for callers who want to handle approval steps generically.
export type { AgentStep, ApprovalStep, WorkflowStep, WorkflowDefinition };
