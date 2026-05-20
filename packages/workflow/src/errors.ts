export type WorkflowErrorCode =
  | "WF_VALIDATION"
  | "WF_CYCLE"
  | "WF_STEP_NOT_FOUND"
  | "WF_MISSING_INPUTS"
  | "WF_TEMPLATE"
  | "WF_SELECTOR_CYCLE"
  | "WF_STATE_STORE"
  | "WF_LOCK_TIMEOUT"
  | "WF_ARTIFACT_STORE";

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

export class MissingInputsError extends WorkflowError {
  readonly stepId: string;
  readonly missing: string[];

  constructor(stepId: string, missing: string[], options?: ErrorOptions) {
    const list = missing.map((p) => `  - ${p}`).join("\n");
    super(
      "WF_MISSING_INPUTS",
      `Cannot run step "${stepId}" with --only: required input file(s) missing on disk:\n${list}\nHint: run with --through ${stepId} to produce them, or use --input <name>=<path> to inject an external file.`,
      options,
    );
    this.name = "MissingInputsError";
    this.stepId = stepId;
    this.missing = missing;
  }
}

export class TemplateError extends WorkflowError {
  readonly placeholder: string;

  constructor(placeholder: string, options?: ErrorOptions) {
    super(
      "WF_TEMPLATE",
      `Unknown template placeholder ${placeholder}. Only {{inputs.<name>}} and {{outputs.<name>}} are supported.`,
      options,
    );
    this.name = "TemplateError";
    this.placeholder = placeholder;
  }
}

export class CycleInSelectorResolutionError extends WorkflowError {
  readonly cycle: string[];

  constructor(cycle: string[], options?: ErrorOptions) {
    super(
      "WF_SELECTOR_CYCLE",
      `Cycle detected during selector resolution: ${cycle.join(" -> ")}`,
      options,
    );
    this.name = "CycleInSelectorResolutionError";
    this.cycle = cycle;
  }
}

export class StateStoreError extends WorkflowError {
  constructor(message: string, options?: ErrorOptions) {
    super("WF_STATE_STORE", message, options);
    this.name = "StateStoreError";
  }
}

export class LockTimeoutError extends WorkflowError {
  readonly lockPath: string;

  constructor(lockPath: string, options?: ErrorOptions) {
    super(
      "WF_LOCK_TIMEOUT",
      `Timed out waiting for lock at ${lockPath}`,
      options,
    );
    this.name = "LockTimeoutError";
    this.lockPath = lockPath;
  }
}

export class ArtifactStoreError extends WorkflowError {
  constructor(message: string, options?: ErrorOptions) {
    super("WF_ARTIFACT_STORE", message, options);
    this.name = "ArtifactStoreError";
  }
}

function formatIssues(issues: ValidationIssue[]): string {
  if (issues.length === 0) {
    return "Workflow validation failed";
  }
  const lines = issues.map((issue) => `  - ${issue.path}: ${issue.message}`);
  return `Workflow validation failed:\n${lines.join("\n")}`;
}
