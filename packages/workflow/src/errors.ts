export type WorkflowErrorCode =
  | "WF_VALIDATION"
  | "WF_CYCLE"
  | "WF_STEP_NOT_FOUND";

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;

  constructor(code: WorkflowErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkflowError";
    this.code = code;
  }
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export class WorkflowValidationError extends WorkflowError {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[], options?: ErrorOptions) {
    super("WF_VALIDATION", formatIssues(issues), options);
    this.name = "WorkflowValidationError";
    this.issues = issues;
  }
}

export class WorkflowCycleError extends WorkflowError {
  readonly cycle: string[];

  constructor(cycle: string[], options?: ErrorOptions) {
    super(
      "WF_CYCLE",
      `Workflow has a cycle in depends_on: ${cycle.join(" -> ")}`,
      options,
    );
    this.name = "WorkflowCycleError";
    this.cycle = cycle;
  }
}

export class StepNotFoundError extends WorkflowError {
  readonly stepId: string;

  constructor(stepId: string, options?: ErrorOptions) {
    super("WF_STEP_NOT_FOUND", `Step not found: ${stepId}`, options);
    this.name = "StepNotFoundError";
    this.stepId = stepId;
  }
}

function formatIssues(issues: ValidationIssue[]): string {
  if (issues.length === 0) {
    return "Workflow validation failed";
  }
  const lines = issues.map((issue) => `  - ${issue.path}: ${issue.message}`);
  return `Workflow validation failed:\n${lines.join("\n")}`;
}
