import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  WorkflowCycleError,
  WorkflowValidationError,
} from "../errors.js";
import { parseWorkflowDefinition } from "../schema.js";
import type { AgentStep, ApprovalStep } from "../types.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

const MINIMAL_WORKFLOW = `
id: minimal
artifacts_dir: ./artifacts
project_id: proj
steps:
  - id: only_step
    type: agent
    agent: claude-code
    prompt: |
      Write to {{outputs.note}}.
    outputs:
      note: note.md
`;

describe("parseWorkflowDefinition", () => {
  it("parses the feature-dev fixture", () => {
    const wf = parseWorkflowDefinition(loadFixture("valid-workflow.yaml"));
    expect(wf.id).toBe("feature-dev");
    expect(wf.artifacts_dir).toBe("./workflow-artifacts");
    expect(wf.project_id).toBe("my-project");
    expect(wf.steps).toHaveLength(4);
    expect(wf.inputs?.[0]?.name).toBe("feature_description");

    const designDoc = wf.steps[0] as AgentStep;
    expect(designDoc.type).toBe("agent");
    expect(designDoc.outputs.design).toBe("design.md");
    expect(designDoc.timeout_minutes).toBe(30);

    const designReview = wf.steps[1] as ApprovalStep;
    expect(designReview.type).toBe("human_approval");
    expect(designReview.on_reject).toBe("design_doc");
    expect(designReview.max_revisions).toBe(5);
  });

  it("accepts a minimal one-step workflow", () => {
    const wf = parseWorkflowDefinition(MINIMAL_WORKFLOW);
    expect(wf.steps).toHaveLength(1);
    expect(wf.steps[0]?.id).toBe("only_step");
  });

  it("accepts a chain ending in human_approval", () => {
    const yaml = `
id: chain
artifacts_dir: ./a
project_id: p
steps:
  - id: gen
    type: agent
    agent: claude-code
    prompt: "write {{outputs.doc}}"
    outputs:
      doc: doc.md
  - id: review
    type: human_approval
    depends_on: [gen]
    message: review it
    on_reject: gen
`;
    const wf = parseWorkflowDefinition(yaml);
    expect(wf.steps[1]?.type).toBe("human_approval");
  });

  it("rejects malformed YAML", () => {
    expect(() => parseWorkflowDefinition(":\n  bad: [unterminated")).toThrow(
      WorkflowValidationError,
    );
  });

  it("rejects a YAML scalar at the document root", () => {
    expect(() => parseWorkflowDefinition("just a string")).toThrow(
      WorkflowValidationError,
    );
  });

  it("rejects an unknown step type", () => {
    const yaml = `
id: bad
artifacts_dir: ./a
project_id: p
steps:
  - id: x
    type: unknown_kind
    agent: claude-code
    prompt: hi
    outputs:
      o: o.md
`;
    expect(() => parseWorkflowDefinition(yaml)).toThrow(WorkflowValidationError);
  });

  it("rejects missing required top-level fields", () => {
    const yaml = `
id: bad
steps:
  - id: x
    type: agent
    agent: claude-code
    prompt: hi
    outputs:
      o: o.md
`;
    try {
      parseWorkflowDefinition(yaml);
      throw new Error("expected validation error");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowValidationError);
      const issues = (err as WorkflowValidationError).issues.map((i) => i.path);
      expect(issues).toContain("artifacts_dir");
      expect(issues).toContain("project_id");
    }
  });

  it("rejects duplicate step IDs", () => {
    const yaml = `
id: dup
artifacts_dir: ./a
project_id: p
steps:
  - id: same
    type: agent
    agent: claude-code
    prompt: "write {{outputs.o}}"
    outputs:
      o: o.md
  - id: same
    type: agent
    agent: claude-code
    prompt: "write {{outputs.o}}"
    outputs:
      o: o.md
`;
    expect(() => parseWorkflowDefinition(yaml)).toThrow(/duplicate step id "same"/);
  });

  it("rejects depends_on pointing at an unknown step", () => {
    const yaml = `
id: missing-dep
artifacts_dir: ./a
project_id: p
steps:
  - id: a
    type: agent
    agent: claude-code
    prompt: "write {{outputs.o}}"
    outputs:
      o: o.md
  - id: b
    type: agent
    agent: claude-code
    depends_on: [ghost]
    prompt: "write {{outputs.o}}"
    outputs:
      o: o.md
`;
    expect(() => parseWorkflowDefinition(yaml)).toThrow(/unknown step "ghost"/);
  });

  it("rejects a self-loop in depends_on", () => {
    const yaml = `
id: self
artifacts_dir: ./a
project_id: p
steps:
  - id: a
    type: agent
    agent: claude-code
    depends_on: [a]
    prompt: "write {{outputs.o}}"
    outputs:
      o: o.md
`;
    expect(() => parseWorkflowDefinition(yaml)).toThrow(WorkflowValidationError);
  });

  it("detects cycles in depends_on and throws WorkflowCycleError", () => {
    const yaml = `
id: cyc
artifacts_dir: ./a
project_id: p
steps:
  - id: a
    type: agent
    agent: claude-code
    depends_on: [b]
    prompt: "write {{outputs.o}}"
    outputs:
      o: o.md
  - id: b
    type: agent
    agent: claude-code
    depends_on: [a]
    prompt: "write {{outputs.o}}"
    outputs:
      o: o.md
`;
    try {
      parseWorkflowDefinition(yaml);
      throw new Error("expected cycle error");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowCycleError);
      expect((err as WorkflowCycleError).cycle).toContain("a");
      expect((err as WorkflowCycleError).cycle).toContain("b");
    }
  });

  it("rejects on_reject pointing to an unknown step", () => {
    const yaml = `
id: bad-reject
artifacts_dir: ./a
project_id: p
steps:
  - id: gen
    type: agent
    agent: claude-code
    prompt: "write {{outputs.o}}"
    outputs:
      o: o.md
  - id: review
    type: human_approval
    depends_on: [gen]
    message: review
    on_reject: nobody
`;
    expect(() => parseWorkflowDefinition(yaml)).toThrow(/unknown step "nobody"/);
  });

  it("rejects on_reject pointing to a downstream (non-upstream) step", () => {
    // `review` rejects to `later`, but `later` is downstream of `review`,
    // not reachable via review.depends_on.
    const yaml = `
id: downstream-reject
artifacts_dir: ./a
project_id: p
steps:
  - id: gen
    type: agent
    agent: claude-code
    prompt: "write {{outputs.o}}"
    outputs:
      o: o.md
  - id: review
    type: human_approval
    depends_on: [gen]
    message: review
    on_reject: later
  - id: later
    type: agent
    agent: claude-code
    depends_on: [review]
    prompt: "write {{outputs.o}}"
    outputs:
      o: o2.md
`;
    expect(() => parseWorkflowDefinition(yaml)).toThrow(
      /must be upstream of approval step "review"/,
    );
  });

  it("rejects {{inputs.X}} that is not declared", () => {
    const yaml = `
id: bad-template
artifacts_dir: ./a
project_id: p
steps:
  - id: s
    type: agent
    agent: claude-code
    prompt: "read {{inputs.nope}} and write {{outputs.o}}"
    outputs:
      o: o.md
`;
    expect(() => parseWorkflowDefinition(yaml)).toThrow(
      /\{\{inputs\.nope\}\}/,
    );
  });

  it("rejects {{outputs.X}} that is not declared", () => {
    const yaml = `
id: bad-output
artifacts_dir: ./a
project_id: p
steps:
  - id: s
    type: agent
    agent: claude-code
    prompt: "write {{outputs.missing}}"
    outputs:
      o: o.md
`;
    expect(() => parseWorkflowDefinition(yaml)).toThrow(
      /\{\{outputs\.missing\}\}/,
    );
  });

  it("accepts {{inputs.X}} that resolves to a workflow-level input", () => {
    const yaml = `
id: ok
artifacts_dir: ./a
project_id: p
inputs:
  - name: feature
    path: ./feature.md
steps:
  - id: s
    type: agent
    agent: claude-code
    prompt: "read {{inputs.feature}} and write {{outputs.o}}"
    outputs:
      o: o.md
`;
    const wf = parseWorkflowDefinition(yaml);
    expect(wf.inputs?.[0]?.name).toBe("feature");
  });

  it("rejects a workflow-level input that collides with a step-local input name", () => {
    const yaml = `
id: collide
artifacts_dir: ./a
project_id: p
inputs:
  - name: design
    path: ./design.md
steps:
  - id: gen
    type: agent
    agent: claude-code
    prompt: "write {{outputs.o}}"
    outputs:
      o: o.md
  - id: use
    type: agent
    agent: claude-code
    depends_on: [gen]
    inputs:
      design: o.md
    prompt: "read {{inputs.design}} and write {{outputs.o2}}"
    outputs:
      o2: o2.md
`;
    expect(() => parseWorkflowDefinition(yaml)).toThrow(
      /collides with a workflow-level input/,
    );
  });
});
