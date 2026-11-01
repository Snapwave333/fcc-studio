import { describe, expect, it } from "vitest";
import { buildPrompt } from "./prompt";

describe("buildPrompt", () => {
  it("passes plain text through unchanged", () => {
    expect(buildPrompt({ text: "fix the header" })).toEqual({ prompt: "fix the header", systemPrompt: "" });
  });

  it("includes the selected preview element", () => {
    const { prompt } = buildPrompt({
      text: "make it pink",
      element: {
        tag: "button",
        id: "cta",
        classes: ["btn", "primary"],
        selector: "#cta",
        text: "Buy",
        html: '<button id="cta">Buy</button>',
        rect: { x: 0, y: 0, width: 10, height: 10 },
      },
    });
    expect(prompt).toContain("make it pink");
    expect(prompt).toContain("[Selected UI element from live preview]");
    expect(prompt).toContain("selector: #cta");
    expect(prompt).toContain("classes: btn, primary");
  });

  it("prefixes attached skills", () => {
    expect(buildPrompt({ text: "go", skill: "deploy" }).prompt).toBe('Use the "deploy" skill for this task.\n\ngo');
  });

  it("builds a system prompt from instructions and memory with a size cap", () => {
    const memory = Array.from({ length: 500 }, (_, i) => ({ kind: "note", title: `t${i}`, body: "x".repeat(40) }));
    const { systemPrompt } = buildPrompt({ text: "go", instructions: "  Use pnpm  ", memory });
    expect(systemPrompt.startsWith("Project instructions:\nUse pnpm\n\nRelevant memory:\n- [note] t0: ")).toBe(true);
    expect(systemPrompt.length).toBeLessThan(6500);
  });
});
