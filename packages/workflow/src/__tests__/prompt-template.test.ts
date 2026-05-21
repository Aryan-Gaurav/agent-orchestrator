import { describe, expect, it } from "vitest";

import { TemplateError } from "../errors.js";
import {
  appendExecutionContract,
  prependFeedback,
  renderPrompt,
} from "../prompt-template.js";

describe("renderPrompt", () => {
  it("substitutes {{inputs.X}} and {{outputs.Y}} placeholders", () => {
    const template = "Read {{inputs.design}} and write {{outputs.hld}}.";
    const result = renderPrompt(template, {
      inputs: { design: "/abs/design.md" },
      outputs: { hld: "/abs/hld.md" },
    });
    expect(result).toBe("Read /abs/design.md and write /abs/hld.md.");
  });

  it("substitutes multiple occurrences of the same placeholder", () => {
    const template = "{{inputs.x}} and {{inputs.x}} again at {{inputs.x}}.";
    const result = renderPrompt(template, {
      inputs: { x: "VAL" },
      outputs: {},
    });
    expect(result).toBe("VAL and VAL again at VAL.");
  });

  it("tolerates whitespace inside placeholders", () => {
    const template = "Use {{ inputs.foo }} now.";
    const result = renderPrompt(template, {
      inputs: { foo: "BAR" },
      outputs: {},
    });
    expect(result).toBe("Use BAR now.");
  });

  it("throws TemplateError for unknown namespace placeholders", () => {
    const template = "Hello {{env.HOME}}";
    expect(() =>
      renderPrompt(template, { inputs: {}, outputs: {} }),
    ).toThrow(TemplateError);
  });

  it("throws TemplateError when a referenced input is not provided", () => {
    const template = "Use {{inputs.missing}}.";
    expect(() =>
      renderPrompt(template, { inputs: {}, outputs: {} }),
    ).toThrow(TemplateError);
  });

  it("is idempotent: rendering already-rendered output is a no-op", () => {
    const template = "Read {{inputs.design}} to {{outputs.hld}}.";
    const once = renderPrompt(template, {
      inputs: { design: "/abs/design.md" },
      outputs: { hld: "/abs/hld.md" },
    });
    const twice = renderPrompt(once, {
      inputs: { design: "/abs/design.md" },
      outputs: { hld: "/abs/hld.md" },
    });
    expect(twice).toBe(once);
  });
});

describe("appendExecutionContract", () => {
  it("includes every declared output path", () => {
    const result = appendExecutionContract("Do the thing.", {
      design: "/abs/design.md",
      hld: "/abs/hld.md",
    });
    expect(result).toContain("Do the thing.");
    expect(result).toContain("=== AOW EXECUTION CONTRACT ===");
    expect(result).toContain("design: /abs/design.md");
    expect(result).toContain("hld: /abs/hld.md");
    expect(result).toContain("Do NOT commit or push.");
    expect(result).toContain("Stop working");
  });

  it("preserves the original prompt content verbatim", () => {
    const original = "First line.\nSecond line.";
    const result = appendExecutionContract(original, { x: "x.md" });
    expect(result.startsWith(original)).toBe(true);
  });

  it("handles empty outputs map without crashing", () => {
    const result = appendExecutionContract("p", {});
    expect(result).toContain("(no declared outputs)");
  });

  it("appends the §17.3 citation contract footer", () => {
    const result = appendExecutionContract("body", { x: "x.md" });
    expect(result).toContain("=== CITATION CONTRACT ===");
    expect(result).toContain("=== END CITATION CONTRACT ===");
    expect(result).toContain("WRITING");
    expect(result).toContain("READING");
    expect(result).toContain("PROPAGATION");
    expect(result).toContain("ERROR HANDLING");
    expect(result).toContain("node .ao/aow-ref");
    expect(result).toContain("hop_depth_4");
    expect(result).toContain("claim_mismatch");
    expect(result).toContain("<!-- ref: <file>#<section> claim=\"...\" -->");
    expect(result).toContain("// ref: <file>#<section> claim=\"...\"");
  });

  it("places the citation contract after the execution contract", () => {
    const result = appendExecutionContract("body", { x: "x.md" });
    expect(result.indexOf("=== END CONTRACT ===")).toBeLessThan(
      result.indexOf("=== CITATION CONTRACT ==="),
    );
  });
});

describe("prependFeedback", () => {
  it("includes the feedback text and a clear delimiter", () => {
    const result = prependFeedback("Original prompt body.", "Please add tests.");
    expect(result).toContain("=== PRIOR ATTEMPT FEEDBACK ===");
    expect(result).toContain("=== END FEEDBACK ===");
    expect(result).toContain("Please add tests.");
    expect(result.indexOf("=== PRIOR ATTEMPT FEEDBACK ===")).toBeLessThan(
      result.indexOf("Original prompt body."),
    );
  });

  it("quotes multi-line feedback so it is clearly separated from the prompt", () => {
    const result = prependFeedback("body", "line one\nline two");
    expect(result).toContain("> line one");
    expect(result).toContain("> line two");
  });
});
