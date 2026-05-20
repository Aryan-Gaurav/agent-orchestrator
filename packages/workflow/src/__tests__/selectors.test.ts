import { describe, expect, it } from "vitest";

import { MissingInputsError } from "../errors.js";
import { resolveSelector } from "../selectors.js";
import type {
  RunState,
  StepStatus,
  WorkflowDefinition,
} from "../types.js";

interface StatusOverrides {
  [stepId: string]: StepStatus;
}

function makeState(workflow: WorkflowDefinition, overrides: StatusOverrides = {}): RunState {
  const steps: RunState["steps"] = {};
  for (const step of workflow.steps) {
    steps[step.id] = { status: overrides[step.id] ?? "pending" };
  }
  return {
    run_id: "run-1",
    workflow_id: workflow.id,
    started_at: "2026-05-20T00:00:00Z",
    updated_at: "2026-05-20T00:00:00Z",
    status: "pending",
    inputs: [],
    steps,
  };
}

// A linear chain: design -> hld -> lld -> plan
const LINEAR_WORKFLOW: WorkflowDefinition = {
  id: "linear",
  artifacts_dir: "./artifacts",
  project_id: "proj",
  steps: [
    {
      id: "design",
      type: "agent",
      agent: "claude-code",
      prompt: "design",
      outputs: { design: "design.md" },
    },
    {
      id: "hld",
      type: "agent",
      agent: "claude-code",
      depends_on: ["design"],
      inputs: { design: "design.md" },
      prompt: "hld",
      outputs: { hld: "hld.md" },
    },
    {
      id: "lld",
      type: "agent",
      agent: "claude-code",
      depends_on: ["hld"],
      inputs: { hld: "hld.md" },
      prompt: "lld",
      outputs: { lld: "lld.md" },
    },
    {
      id: "plan",
      type: "agent",
      agent: "claude-code",
      depends_on: ["lld"],
      inputs: { lld: "lld.md" },
      prompt: "plan",
      outputs: { plan: "plan.md" },
    },
  ],
};

// Diamond plus a disconnected node:
//   root -> left -> join
//   root -> right -> join
//   isolated (no deps, no dependents)
const DIAMOND_WORKFLOW: WorkflowDefinition = {
  id: "diamond",
  artifacts_dir: "./artifacts",
  project_id: "proj",
  steps: [
    {
      id: "root",
      type: "agent",
      agent: "claude-code",
      prompt: "root",
      outputs: { root: "root.md" },
    },
    {
      id: "left",
      type: "agent",
      agent: "claude-code",
      depends_on: ["root"],
      inputs: { root: "root.md" },
      prompt: "left",
      outputs: { left: "left.md" },
    },
    {
      id: "right",
      type: "agent",
      agent: "claude-code",
      depends_on: ["root"],
      inputs: { root: "root.md" },
      prompt: "right",
      outputs: { right: "right.md" },
    },
    {
      id: "join",
      type: "agent",
      agent: "claude-code",
      depends_on: ["left", "right"],
      inputs: { left: "left.md", right: "right.md" },
      prompt: "join",
      outputs: { join: "join.md" },
    },
    {
      id: "isolated",
      type: "agent",
      agent: "claude-code",
      prompt: "isolated",
      outputs: { iso: "iso.md" },
    },
  ],
};

const SINGLE_STEP_WORKFLOW: WorkflowDefinition = {
  id: "single",
  artifacts_dir: "./artifacts",
  project_id: "proj",
  steps: [
    {
      id: "only",
      type: "agent",
      agent: "claude-code",
      prompt: "do it",
      outputs: { out: "out.md" },
    },
  ],
};

describe("resolveSelector - all", () => {
  it("returns every step in topological order when state is fresh", async () => {
    const state = makeState(LINEAR_WORKFLOW);
    const { toRun, warnings } = await resolveSelector(LINEAR_WORKFLOW, state, {
      kind: "all",
    });
    expect(toRun).toEqual(["design", "hld", "lld", "plan"]);
    expect(warnings).toEqual([]);
  });

  it("skips completed steps and includes stale ones", async () => {
    const state = makeState(LINEAR_WORKFLOW, {
      design: "completed",
      hld: "stale",
      lld: "pending",
    });
    const { toRun } = await resolveSelector(LINEAR_WORKFLOW, state, {
      kind: "all",
    });
    expect(toRun).toEqual(["hld", "lld", "plan"]);
  });

  it("handles disconnected components without losing nodes", async () => {
    const state = makeState(DIAMOND_WORKFLOW);
    const { toRun } = await resolveSelector(DIAMOND_WORKFLOW, state, {
      kind: "all",
    });
    expect(toRun).toContain("isolated");
    // root must appear before its dependents
    expect(toRun.indexOf("root")).toBeLessThan(toRun.indexOf("left"));
    expect(toRun.indexOf("root")).toBeLessThan(toRun.indexOf("right"));
    expect(toRun.indexOf("left")).toBeLessThan(toRun.indexOf("join"));
    expect(toRun.indexOf("right")).toBeLessThan(toRun.indexOf("join"));
  });
});

describe("resolveSelector - only", () => {
  it("returns [stepId] when all declared inputs exist on disk", async () => {
    const state = makeState(LINEAR_WORKFLOW);
    const fileExists = async () => true;
    const { toRun } = await resolveSelector(
      LINEAR_WORKFLOW,
      state,
      { kind: "only", stepId: "hld" },
      { fileExists },
    );
    expect(toRun).toEqual(["hld"]);
  });

  it("throws MissingInputsError when inputs are missing on disk", async () => {
    const state = makeState(LINEAR_WORKFLOW);
    const fileExists = async () => false;
    await expect(
      resolveSelector(
        LINEAR_WORKFLOW,
        state,
        { kind: "only", stepId: "hld" },
        { fileExists },
      ),
    ).rejects.toBeInstanceOf(MissingInputsError);

    try {
      await resolveSelector(
        LINEAR_WORKFLOW,
        state,
        { kind: "only", stepId: "hld" },
        { fileExists },
      );
    } catch (err) {
      expect(err).toBeInstanceOf(MissingInputsError);
      const e = err as MissingInputsError;
      expect(e.stepId).toBe("hld");
      expect(e.message).toContain("hld");
      expect(e.message).toContain("design.md");
    }
  });

  it("returns [stepId] with no input check for agent steps that declare no inputs", async () => {
    const state = makeState(LINEAR_WORKFLOW);
    let called = false;
    const fileExists = async () => {
      called = true;
      return false;
    };
    const { toRun } = await resolveSelector(
      LINEAR_WORKFLOW,
      state,
      { kind: "only", stepId: "design" },
      { fileExists },
    );
    expect(toRun).toEqual(["design"]);
    expect(called).toBe(false);
  });
});

describe("resolveSelector - from", () => {
  it("returns step plus all downstream steps in topological order", async () => {
    const state = makeState(LINEAR_WORKFLOW);
    const { toRun } = await resolveSelector(LINEAR_WORKFLOW, state, {
      kind: "from",
      stepId: "hld",
    });
    expect(toRun).toEqual(["hld", "lld", "plan"]);
  });

  it("for diamond, --from root returns the whole connected component", async () => {
    const state = makeState(DIAMOND_WORKFLOW);
    const { toRun } = await resolveSelector(DIAMOND_WORKFLOW, state, {
      kind: "from",
      stepId: "root",
    });
    expect(toRun).toContain("root");
    expect(toRun).toContain("left");
    expect(toRun).toContain("right");
    expect(toRun).toContain("join");
    expect(toRun).not.toContain("isolated");
  });
});

describe("resolveSelector - to", () => {
  it("returns step plus all transitive deps in topological order", async () => {
    const state = makeState(LINEAR_WORKFLOW);
    const { toRun } = await resolveSelector(LINEAR_WORKFLOW, state, {
      kind: "to",
      stepId: "lld",
    });
    expect(toRun).toEqual(["design", "hld", "lld"]);
  });
});

describe("resolveSelector - through", () => {
  it("returns missing deps plus step, skipping already-completed upstream", async () => {
    const state = makeState(LINEAR_WORKFLOW, {
      design: "completed",
      hld: "pending",
      lld: "pending",
    });
    const { toRun } = await resolveSelector(LINEAR_WORKFLOW, state, {
      kind: "through",
      stepId: "lld",
    });
    expect(toRun).toEqual(["hld", "lld"]);
  });

  it("includes all upstream when nothing is completed", async () => {
    const state = makeState(LINEAR_WORKFLOW);
    const { toRun } = await resolveSelector(LINEAR_WORKFLOW, state, {
      kind: "through",
      stepId: "lld",
    });
    expect(toRun).toEqual(["design", "hld", "lld"]);
  });
});

describe("resolveSelector - rerun", () => {
  it("returns [stepId] alone with no warning when nothing downstream is completed", async () => {
    const state = makeState(LINEAR_WORKFLOW, {
      design: "completed",
      hld: "completed",
      lld: "pending",
      plan: "pending",
    });
    const { toRun, warnings } = await resolveSelector(LINEAR_WORKFLOW, state, {
      kind: "rerun",
      stepId: "hld",
    });
    expect(toRun).toEqual(["hld"]);
    expect(warnings).toEqual([]);
  });

  it("emits a cascade warning when downstream is completed", async () => {
    const state = makeState(LINEAR_WORKFLOW, {
      design: "completed",
      hld: "completed",
      lld: "completed",
      plan: "completed",
    });
    const { toRun, warnings } = await resolveSelector(LINEAR_WORKFLOW, state, {
      kind: "rerun",
      stepId: "hld",
    });
    expect(toRun).toEqual(["hld"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("lld");
    expect(warnings[0]).toContain("plan");
  });
});

describe("resolveSelector - single-step workflow", () => {
  it("handles a one-node graph for every selector", async () => {
    const wf = SINGLE_STEP_WORKFLOW;
    const state = makeState(wf);
    const fileExists = async () => true;

    expect((await resolveSelector(wf, state, { kind: "all" })).toRun).toEqual([
      "only",
    ]);
    expect(
      (await resolveSelector(wf, state, { kind: "from", stepId: "only" })).toRun,
    ).toEqual(["only"]);
    expect(
      (await resolveSelector(wf, state, { kind: "to", stepId: "only" })).toRun,
    ).toEqual(["only"]);
    expect(
      (await resolveSelector(wf, state, { kind: "through", stepId: "only" }))
        .toRun,
    ).toEqual(["only"]);
    expect(
      (await resolveSelector(
        wf,
        state,
        { kind: "only", stepId: "only" },
        { fileExists },
      )).toRun,
    ).toEqual(["only"]);
    expect(
      (await resolveSelector(wf, state, { kind: "rerun", stepId: "only" })).toRun,
    ).toEqual(["only"]);
  });
});
