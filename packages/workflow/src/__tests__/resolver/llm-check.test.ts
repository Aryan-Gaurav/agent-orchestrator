// Phase 3.12 — llm-check.ts unit tests.
//
// We mock node:child_process.execFile so no real `claude` CLI is invoked.

import { describe, expect, it, vi, beforeEach } from "vitest";

type ExecFileCb = (
  err: (NodeJS.ErrnoException & { signal?: string; killed?: boolean }) | null,
  stdout: string,
  stderr: string,
) => void;

type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: unknown,
  cb: ExecFileCb,
) => void;

let mockExec: ExecFileFn = () => {
  throw new Error("mockExec not set");
};

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return {
    ...actual,
    execFile: (
      file: string,
      args: readonly string[],
      options: unknown,
      cb: ExecFileCb,
    ) => mockExec(file, args, options, cb),
  };
});

// Imported AFTER vi.mock so the module picks up the mocked execFile.
const { checkClaimWithClaude, buildPrompt } = await import(
  "../../resolver/llm-check.js"
);

function setExec(
  result:
    | { stdout: string }
    | { err: NodeJS.ErrnoException & { signal?: string; killed?: boolean } },
): readonly string[] {
  let capturedArgs: readonly string[] = [];
  mockExec = (_file, args, _options, cb) => {
    capturedArgs = args;
    if ("err" in result) {
      cb(result.err, "", "");
    } else {
      cb(null, result.stdout, "");
    }
  };
  return capturedArgs as never;
}

beforeEach(() => {
  delete process.env.AOW_LLM_CHECK_STUB;
});

describe("checkClaimWithClaude", () => {
  it("returns {faithful: true, reason} when .result is faithful JSON", async () => {
    setExec({
      stdout: JSON.stringify({
        type: "result",
        result: JSON.stringify({ faithful: true, reason: "paraphrase ok" }),
      }),
    });
    const v = await checkClaimWithClaude({
      sectionContent: "function foo() { throw new Error('x'); }",
      claim: "foo throws an error",
    });
    expect(v).toEqual({ faithful: true, reason: "paraphrase ok" });
  });

  it("returns {faithful: false, reason} when .result says unfaithful", async () => {
    setExec({
      stdout: JSON.stringify({
        type: "result",
        result: JSON.stringify({ faithful: false, reason: "invented detail" }),
      }),
    });
    const v = await checkClaimWithClaude({
      sectionContent: "function foo() {}",
      claim: "foo implements raft consensus",
    });
    expect(v).toEqual({ faithful: false, reason: "invented detail" });
  });

  it("returns null when execFile errors with ENOENT (claude not on PATH)", async () => {
    const enoent = new Error("spawn claude ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    setExec({ err: enoent });
    const v = await checkClaimWithClaude({
      sectionContent: "x",
      claim: "y",
    });
    expect(v).toBeNull();
  });

  it("returns null on timeout (SIGTERM)", async () => {
    const tmo = new Error("timed out") as NodeJS.ErrnoException & {
      signal?: string;
      killed?: boolean;
    };
    tmo.signal = "SIGTERM";
    tmo.killed = true;
    setExec({ err: tmo });
    const v = await checkClaimWithClaude({ sectionContent: "x", claim: "y" });
    expect(v).toBeNull();
  });

  it("returns null when outer stdout is malformed JSON", async () => {
    setExec({ stdout: "not json at all" });
    const v = await checkClaimWithClaude({ sectionContent: "x", claim: "y" });
    expect(v).toBeNull();
  });

  it("returns null when outer JSON is valid but .result is malformed", async () => {
    setExec({
      stdout: JSON.stringify({ type: "result", result: "not json either" }),
    });
    const v = await checkClaimWithClaude({ sectionContent: "x", claim: "y" });
    expect(v).toBeNull();
  });

  it("returns null when .result parses but lacks a boolean faithful field", async () => {
    setExec({
      stdout: JSON.stringify({
        type: "result",
        result: JSON.stringify({ verdict: "yes" }),
      }),
    });
    const v = await checkClaimWithClaude({ sectionContent: "x", claim: "y" });
    expect(v).toBeNull();
  });

  it("truncates section content over 4000 chars in the prompt", async () => {
    let capturedPrompt = "";
    mockExec = (_file, args, _options, cb) => {
      // args = ["-p", "--output-format", "json", prompt]
      capturedPrompt = args[3] ?? "";
      cb(
        null,
        JSON.stringify({
          type: "result",
          result: JSON.stringify({ faithful: true, reason: "ok" }),
        }),
        "",
      );
    };
    const big = "a".repeat(5000);
    await checkClaimWithClaude({ sectionContent: big, claim: "claim" });
    expect(capturedPrompt).toContain("... [truncated]");
    // The full 5000-char repeated block must NOT survive verbatim.
    expect(capturedPrompt.includes("a".repeat(5000))).toBe(false);
  });

  it("AOW_LLM_CHECK_STUB=faithful bypasses execFile and returns canned verdict", async () => {
    process.env.AOW_LLM_CHECK_STUB = "faithful";
    let called = false;
    mockExec = () => {
      called = true;
    };
    const v = await checkClaimWithClaude({ sectionContent: "x", claim: "y" });
    expect(called).toBe(false);
    expect(v).toEqual({ faithful: true, reason: "stubbed: faithful" });
  });
});

describe("buildPrompt", () => {
  it("inlines short section content verbatim", () => {
    const p = buildPrompt("hello world", "claim text");
    expect(p).toContain("hello world");
    expect(p).toContain("CLAIM: claim text");
    expect(p).not.toContain("... [truncated]");
  });
});
