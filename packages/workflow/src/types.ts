// Type definitions for the workflow engine. No runtime logic lives here —
// see schema.ts for validation and engine.ts (later phase) for execution.

export type WorkflowID = string;
export type StepID = string;
export type RunID = string;

export type StepType = "agent" | "human_approval";

export type StepStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "stale";

export type SelectorKind = "all" | "only" | "from" | "to" | "through" | "rerun";

export interface WorkflowInput {
  name: string;
  path: string;
}

export interface StepCommon {
  id: StepID;
  type: StepType;
  depends_on?: StepID[];
}

export interface AgentStep extends StepCommon {
  type: "agent";
  agent: string;
  prompt: string;
  inputs?: Record<string, string>;
  outputs: Record<string, string>;
  timeout_minutes?: number;
  branch?: string;
}

export interface ApprovalStep extends StepCommon {
  type: "human_approval";
  message: string;
  on_reject: StepID;
  max_revisions?: number;
}

export type WorkflowStep = AgentStep | ApprovalStep;

export interface WorkflowDefinition {
  id: WorkflowID;
  description?: string;
  artifacts_dir: string;
  project_id: string;
  inputs?: WorkflowInput[];
  steps: WorkflowStep[];
}

export interface Artifact {
  name: string;
  path: string;
  hash: string;
}

export interface ArtifactRef {
  name: string;
  path: string;
}

export type ResolverErrorKind =
  | "file_not_found"
  | "section_not_found"
  | "claim_mismatch"
  | "malformed_ref"
  | "outside_artifacts_dir";

export type ResolverMatchKind =
  | "exact_substring"
  | "normalized_substring"
  | "token_overlap";

export interface ClaimMatch {
  found: boolean;
  match_kind: ResolverMatchKind | null;
  confidence: number;
}

export interface Citation {
  file: string;
  section: string | null;
  claim: string | null;
}

export interface HopRecord {
  ts: string;
  step_id: string;
  ref: string;
  outcome: "ok" | "error";
  match_kind: ResolverMatchKind | null;
}

export type ResolverResponse =
  | {
      ok: true;
      ref: string;
      artifact_relative_path: string;
      section_heading: string | null;
      section_content: string;
      outgoing_refs: Citation[];
      claim_match: ClaimMatch | null;
      warnings?: string[];
    }
  | {
      ok: false;
      ref: string;
      error: ResolverErrorKind;
      message: string;
      available_sections?: string[];
    };

export interface AttemptRecord {
  session_id: string;
  branch: string;
  started_at: string;
  completed_at?: string;
  inputs: Artifact[];
  outputs: Artifact[];
}

export interface StepState {
  status: StepStatus;
  attempts?: number;
  current_attempt?: AttemptRecord;
  history?: AttemptRecord[];
  awaiting_since?: string;
  failure_reason?: string;
  warnings?: string[];
}

export interface RunState {
  run_id: RunID;
  workflow_id: WorkflowID;
  started_at: string;
  updated_at: string;
  status: StepStatus;
  inputs: Artifact[];
  steps: Record<StepID, StepState>;
}

export type Selector =
  | { kind: "all" }
  | { kind: "only"; stepId: StepID }
  | { kind: "from"; stepId: StepID }
  | { kind: "to"; stepId: StepID }
  | { kind: "through"; stepId: StepID }
  | { kind: "rerun"; stepId: StepID };
