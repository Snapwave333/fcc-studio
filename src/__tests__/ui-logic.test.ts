import { describe, expect, it } from "vitest";
import { normalizeUrl } from "../components/workspace/Preview";
import { languageFor } from "../components/workspace/EditorPane";
import { sanitizeLayout } from "../components/layout/ThreePanel";
import { toolSummary } from "../components/agent/AgentPanel";

describe("preview url normalization", () => {
  it("accepts ports, hosts and full urls", () => {
    expect(normalizeUrl("5173")).toBe("http://127.0.0.1:5173/");
    expect(normalizeUrl("localhost:3000/app")).toBe("http://localhost:3000/app");
    expect(normalizeUrl("https://example.com")).toBe("https://example.com/");
  });

  it("rejects empty and non-http input", () => {
    expect(normalizeUrl("")).toBeNull();
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("editor language detection", () => {
  it("maps extensions", () => {
    expect(languageFor("/a/App.tsx")).toBe("ts");
    expect(languageFor("C:\\x\\main.rs")).toBe("rs");
    expect(languageFor("README.md")).toBe("md");
    expect(languageFor("Makefile")).toBe("");
  });
});

describe("layout persistence", () => {
  it("clamps and defaults stored values", () => {
    expect(sanitizeLayout({ leftW: 5, rightW: 99999, leftOpen: false, rightTab: "git" })).toEqual({
      leftW: 180,
      rightW: 1100,
      leftOpen: false,
      rightOpen: true,
      rightTab: "git",
    });
    expect(sanitizeLayout(null).rightTab).toBe("preview");
    expect(sanitizeLayout({ rightTab: "bogus" }).rightTab).toBe("preview");
  });
});

describe("tool summaries", () => {
  it("prefers the most descriptive input field", () => {
    expect(toolSummary({ id: "1", name: "Bash", input: { command: "npm test", description: "x" } })).toBe("npm test");
    expect(toolSummary({ id: "2", name: "Read", input: { file_path: "a.ts" } })).toBe("a.ts");
    expect(toolSummary({ id: "3", name: "X", input: { nested: { a: 1 } } })).toBe('{"a":1}');
  });
});
