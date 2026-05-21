export type WorkflowErrorCode =
  | "WF_VALIDATION"
  | "WF_CYCLE"
  | "WF_STEP_NOT_FOUND"
  | "WF_MISSING_INPUTS"
  | "WF_TEMPLATE"
  | "WF_SELECTOR_CYCLE"
  | "WF_STATE_STORE"
  | "WF_LOCK_TIMEOUT"
  | "WF_ARTIFACT_STORE"
  | "WF_AO_CONTEXT"
  | "WF_COMPLETION_TIMEOUT"
  | "WF_SESSION_FAILED"
  | "WF_GATE_NOT_AWAITING"
  | "WF_REVISION_LIMIT"
  | "WF_RUN_NOT_FOUND"
  | "WF_DEFINITION_NOT_FOUND"
  | "WF_STEP_TYPE_MISMATCH"
  | "WF_RESOLVER"
  | "WF_WORKSPACE_SETUP"
  | "WF_CITATION";

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

export class AoContextError extends WorkflowError {
  constructor(message: string, options?: ErrorOptions) {
    super("WF_AO_CONTEXT", message, options);
    this.name = "AoContextError";
  }
}

export class GateNotAwaitingError extends WorkflowError {
  readonly stepId: string;
  readonly currentStatus: string;

  constructor(stepId: string, currentStatus: string, options?: ErrorOptions) {
    super(
      "WF_GATE_NOT_AWAITING",
      `Approval step "${stepId}" is not awaiting decision (status: ${currentStatus})`,
      options,
    );
    this.name = "GateNotAwaitingError";
    this.stepId = stepId;
    this.currentStatus = currentStatus;
  }
}

export class RevisionLimitExceededError extends WorkflowError {
  readonly stepId: string;
  readonly limit: number;

  constructor(stepId: string, limit: number, options?: ErrorOptions) {
    super(
      "WF_REVISION_LIMIT",
      `Step "${stepId}" exceeded max_revisions limit (${limit})`,
      options,
    );
    this.name = "RevisionLimitExceededError";
    this.stepId = stepId;
    this.limit = limit;
  }
}

export class RunNotFoundError extends WorkflowError {
  readonly runId: string;

  constructor(runId: string, options?: ErrorOptions) {
    super("WF_RUN_NOT_FOUND", `Run not found: ${runId}`, options);
    this.name = "RunNotFoundError";
    this.runId = runId;
  }
}

export class DefinitionNotFoundError extends WorkflowError {
  readonly path: string;

  constructor(path: string, options?: ErrorOptions) {
    super(
      "WF_DEFINITION_NOT_FOUND",
      `Workflow definition file not found at ${path}`,
      options,
    );
    this.name = "DefinitionNotFoundError";
    this.path = path;
  }
}

export class StepTypeMismatchError extends WorkflowError {
  readonly stepId: string;
  readonly expected: string;
  readonly actual: string;

  constructor(stepId: string, expected: string, actual: string, options?: ErrorOptions) {
    super(
      "WF_STEP_TYPE_MISMATCH",
      `Step "${stepId}" has type "${actual}" but expected "${expected}"`,
      options,
    );
    this.name = "StepTypeMismatchError";
    this.stepId = stepId;
    this.expected = expected;
    this.actual = actual;
  }
}

export class CompletionTimeoutError extends WorkflowError {
  readonly sessionId: string;
  readonly elapsedMs: number;

  constructor(sessionId: string, elapsedMs: number, options?: ErrorOptions) {
    super(
      "WF_COMPLETION_TIMEOUT",
      `Session ${sessionId} did not complete within ${elapsedMs}ms`,
      options,
    );
    this.name = "CompletionTimeoutError";
    this.sessionId = sessionId;
    this.elapsedMs = elapsedMs;
  }
}

function formatIssues(issues: ValidationIssue[]): string {
  if (issues.length === 0) {
    return "Workflow validation failed";
  }
  const lines = issues.map((issue) => `  - ${issue.path}: ${issue.message}`);
  return `Workflow validation failed:\n${lines.join("\n")}`;
}

export class ResolverError extends WorkflowError {
  constructor(message: string, options?: ErrorOptions) {
    super("WF_RESOLVER", message, options);
    this.name = "ResolverError";
  }
}

export class WorkspaceSetupError extends WorkflowError {
  constructor(message: string, options?: ErrorOptions) {
    super("WF_WORKSPACE_SETUP", message, options);
    this.name = "WorkspaceSetupError";
  }
}

export class CitationError extends WorkflowError {
  constructor(message: string, options?: ErrorOptions) {
    super("WF_CITATION", message, options);
    this.name = "CitationError";
  }
}
