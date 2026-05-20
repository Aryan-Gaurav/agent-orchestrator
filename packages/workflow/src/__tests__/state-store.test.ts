import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StateStoreError } from "../errors.js";
import {
  createRunState,
  loadRunState,
  saveRunState,
  updateStep,
} from "../state-store.js";
import type {
  AttemptRecord,
  RunState,
  WorkflowDefinition,
} from "../types.js";

let runDir: string;

beforeEach(async () => {
  runDir = await mkdtemp(join(tmpdir(), "aow-state-"));
});

afterEach(async () => {
  await rm(runDir, { recursive: true, force: true });
});

const workflow: WorkflowDefinition = {
  id: "feature-dev",
  artifacts_dir: "./workflow-artifacts",
  project_id: "proj",
  steps: [
    {
      id: "design_doc",
      type: "agent",
      agent: "claude-code",
      prompt: "produce {{outputs.design}}",
      outputs: { design: "design.md" },
    },
    {
      id: "design_review",
      type: "human_approval",
      depends_on: ["design_doc"],
      message: "Review design",
      on_reject: "design_doc",
    },
  ],
};

describe("createRunState", () => {
  it("produces an initial state with every step pending", async () => {
    const state = await createRunState(runDir, workflow, []);
    expect(state.workflow_id).toBe("feature-dev");
    expect(state.status).toBe("pending");
    expect(state.run_id).toMatch(/^wf-feature-dev-\d{8}T\d{6}$/);
    expect(Object.keys(state.steps)).toEqual(["design_doc", "design_review"]);
    expect(state.steps.design_doc?.status).toBe("pending");
    expect(state.steps.design_review?.status).toBe("pending");
    expect(state.inputs).toEqual([]);
  });

  it("persists initial inputs with their hashes", async () => {
    const inputs = [
      {
        name: "feature_description",
        path: "./feature.md",
        hash: "sha256:abc",
      },
    ];
    const state = await createRunState(runDir, workflow, inputs);
    const reloaded = await loadRunState(runDir);
    expect(reloaded.inputs).toEqual(inputs);
    expect(reloaded.steps).toEqual(state.steps);
  });
});

describe("saveRunState / loadRunState", () => {
  it("round-trips a complete RunState", async () => {
    const attempt: AttemptRecord = {
      session_id: "ses-xyz",
      branch: "aow-feature-dev-design_doc-1",
      started_at: "2026-05-20T12:00:00.000Z",
      completed_at: "2026-05-20T12:15:00.000Z",
      inputs: [
        {
          name: "feature_description",
          path: "./feature.md",
          hash: "sha256:abc",
        },
      ],
      outputs: [
        {
          name: "design",
          path: "workflow-artifacts/design.md",
          hash: "sha256:def",
        },
      ],
    };
    const original: RunState = {
      run_id: "wf-feature-dev-20260520T120000",
      workflow_id: "feature-dev",
      started_at: "2026-05-20T12:00:00.000Z",
      updated_at: "2026-05-20T12:35:00.000Z",
      status: "awaiting_approval",
      inputs: attempt.inputs,
      steps: {
        design_doc: {
          status: "completed",
          attempts: 1,
          current_attempt: attempt,
          history: [],
        },
        design_review: {
          status: "awaiting_approval",
          awaiting_since: "2026-05-20T12:15:00.000Z",
        },
      },
    };
    await saveRunState(runDir, original);
    const loaded = await loadRunState(runDir);
    expect(loaded).toEqual(original);
  });

  it("does not leak a temp file after a successful save", async () => {
    await createRunState(runDir, workflow, []);
    const entries = await readdir(runDir);
    expect(entries).toContain("state.json");
    expect(entries).not.toContain("state.json.tmp");
  });

  it("throws StateStoreError when state.json is missing", async () => {
    await expect(loadRunState(runDir)).rejects.toBeInstanceOf(StateStoreError);
  });

  it("throws StateStoreError when state.json is corrupt JSON", async () => {
    await writeFile(join(runDir, "state.json"), "{not json", "utf8");
    await expect(loadRunState(runDir)).rejects.toBeInstanceOf(StateStoreError);
  });

  it("throws StateStoreError when state.json is structurally invalid", async () => {
    await writeFile(
      join(runDir, "state.json"),
      JSON.stringify({ run_id: "x" }),
      "utf8",
    );
    await expect(loadRunState(runDir)).rejects.toBeInstanceOf(StateStoreError);
  });
});

describe("updateStep", () => {
  it("applies the updater and persists the change", async () => {
    await createRunState(runDir, workflow, []);
    const updated = await updateStep(runDir, "design_doc", (prev) => ({
      ...prev,
      status: "running",
      attempts: (prev.attempts ?? 0) + 1,
    }));
    expect(updated.steps.design_doc?.status).toBe("running");
    expect(updated.steps.design_doc?.attempts).toBe(1);

    const reloaded = await loadRunState(runDir);
    expect(reloaded.steps.design_doc?.status).toBe("running");
    expect(reloaded.steps.design_doc?.attempts).toBe(1);
    // Other steps are untouched.
    expect(reloaded.steps.design_review?.status).toBe("pending");
  });

  it("throws StateStoreError when updating an unknown step", async () => {
    await createRunState(runDir, workflow, []);
    await expect(
      updateStep(runDir, "nope", (prev) => prev),
    ).rejects.toBeInstanceOf(StateStoreError);
  });

  it("serializes concurrent updates via the lock file (no lost writes)", async () => {
    await createRunState(runDir, workflow, []);

    // Each call reads N, writes N+1. Without locking, both calls observe 0
    // and the final value would be 1 (lost update). With locking the final
    // value must equal the number of calls.
    const concurrentCalls = 5;
    const promises: Array<Promise<RunState>> = [];
    for (let i = 0; i < concurrentCalls; i++) {
      promises.push(
        updateStep(runDir, "design_doc", (prev) => ({
          ...prev,
          attempts: (prev.attempts ?? 0) + 1,
        })),
      );
    }
    const results = await Promise.all(promises);
    expect(results).toHaveLength(concurrentCalls);
    const final = await loadRunState(runDir);
    expect(final.steps.design_doc?.attempts).toBe(concurrentCalls);
    // The lock file is cleaned up.
    const entries = await readdir(runDir);
    expect(entries).not.toContain(".state.lock");
  });
});
