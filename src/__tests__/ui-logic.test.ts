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

import { fuzzyScore, rankFiles } from "../components/common/QuickOpen";

describe("quick open ranking", () => {
  const files = ["src/components/agent/AgentPanel.tsx", "src/app.ts", "README.md", "src/lib/api.ts", "e2e/run.mjs"];

  it("matches subsequences and rejects non-matches", () => {
    expect(fuzzyScore("agp", "src/components/agent/AgentPanel.tsx")).toBeGreaterThan(0);
    expect(fuzzyScore("zzz", "src/app.ts")).toBe(-1);
  });

  it("prefers file-name matches over directory matches", () => {
    expect(rankFiles("api", files)[0]).toBe("src/lib/api.ts");
    expect(rankFiles("readme", files)[0]).toBe("README.md");
    expect(rankFiles("AgentPanel", files)[0]).toBe("src/components/agent/AgentPanel.tsx");
  });

  it("returns everything up to the limit for an empty query", () => {
    expect(rankFiles("", files, 2)).toHaveLength(2);
  });
});

import { buildGitMarks } from "../components/nav/LeftPanel";

describe("git decorations", () => {
  it("marks files by status and flags every ancestor folder", () => {
    const marks = buildGitMarks("/work/app", [
      { path: "src/deep/a.ts", x: " ", y: "M", untracked: false },
      { path: "new.txt", x: "?", y: "?", untracked: true },
      { path: "added.ts", x: "A", y: " ", untracked: false },
      { path: "gone.ts", x: " ", y: "D", untracked: false },
    ]);
    expect(marks.files.get("/work/app/src/deep/a.ts")).toBe("M");
    expect(marks.files.get("/work/app/new.txt")).toBe("U");
    expect(marks.files.get("/work/app/added.ts")).toBe("A");
    expect(marks.files.get("/work/app/gone.ts")).toBe("D");
    expect(marks.dirs.has("/work/app/src")).toBe(true);
    expect(marks.dirs.has("/work/app/src/deep")).toBe(true);
  });

  it("normalizes windows roots", () => {
    const marks = buildGitMarks("C:\\Dev\\App", [{ path: "src/x.ts", x: "M", y: " ", untracked: false }]);
    expect(marks.files.get("c:/dev/app/src/x.ts")).toBe("M");
  });
});

import { mentionAt } from "../components/agent/AgentPanel";

describe("@file mentions", () => {
  it("detects a mention token right before the caret", () => {
    expect(mentionAt("fix @src/ap", 11)).toEqual({ start: 4, query: "src/ap" });
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
  });

  it("ignores emails and finished tokens", () => {
    expect(mentionAt("mail me@host", 12)).toBeNull();
    expect(mentionAt("see @a.ts now", 13)).toBeNull();
  });
});
