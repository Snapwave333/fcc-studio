import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "./markdown";

describe("parseInline", () => {
  it("parses code, bold, italic and links", () => {
    const nodes = parseInline("Run `npm test` then **ship** it _now_ via [docs](https://x.dev) or https://y.dev.");
    expect(nodes.map((n) => n.kind)).toEqual(["text", "code", "text", "strong", "text", "em", "text", "link", "text", "link", "text"]);
    expect(nodes[1]).toEqual({ kind: "code", value: "npm test" });
    expect(nodes[7]).toMatchObject({ kind: "link", href: "https://x.dev" });
    expect(nodes[9]).toMatchObject({ kind: "link", href: "https://y.dev" });
    expect(nodes[10]).toEqual({ kind: "text", value: "." });
  });

  it("does not treat snake_case identifiers as emphasis", () => {
    const nodes = parseInline("call my_func_name here");
    expect(nodes).toEqual([{ kind: "text", value: "call my_func_name here" }]);
  });

  it("keeps markdown inside inline code literal", () => {
    expect(parseInline("`**not bold**`")).toEqual([{ kind: "code", value: "**not bold**" }]);
  });
});

describe("parseMarkdown", () => {
  it("parses fenced code blocks with languages", () => {
    const blocks = parseMarkdown("Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\nAfter");
    expect(blocks).toEqual([
      { kind: "paragraph", children: [{ kind: "text", value: "Intro" }] },
      { kind: "code", lang: "ts", value: "const a = 1;\n\nconst b = 2;" },
      { kind: "paragraph", children: [{ kind: "text", value: "After" }] },
    ]);
  });

  it("handles an unterminated fence while streaming", () => {
    const blocks = parseMarkdown("```js\nconsole.log(1)");
    expect(blocks).toEqual([{ kind: "code", lang: "js", value: "console.log(1)" }]);
  });

  it("parses headings, lists, quotes and rules", () => {
    const blocks = parseMarkdown("## Plan\n1. build\n2. test\n- a\n- b\n> note\n---");
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "list", "list", "quote", "rule"]);
    expect(blocks[1]).toMatchObject({ ordered: true, start: 1 });
    expect((blocks[2] as any).items).toHaveLength(2);
  });

  it("parses tables", () => {
    const blocks = parseMarkdown("| file | status |\n|---|:-:|\n| a.ts | ok |\n| b.ts | fail |");
    expect(blocks[0].kind).toBe("table");
    expect((blocks[0] as any).rows).toHaveLength(2);
  });

  it("normalizes windows line endings", () => {
    expect(parseMarkdown("a\r\nb")).toEqual([{ kind: "paragraph", children: [{ kind: "text", value: "a\nb" }] }]);
  });
});
