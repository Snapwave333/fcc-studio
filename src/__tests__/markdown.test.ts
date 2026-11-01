import { describe, expect, it } from "vitest";
import { parseBlocks } from "../lib/markdown";

describe("parseBlocks", () => {
  it("parses fenced code with language", () => {
    const b = parseBlocks("Intro\n\n```ts\nconst a = 1;\n```\nafter");
    expect(b.map((x) => x.type)).toEqual(["p", "code", "p"]);
    expect(b[1]).toMatchObject({ lang: "ts", text: "const a = 1;" });
  });

  it("parses headings, lists and quotes", () => {
    const b = parseBlocks("# Title\n- one\n- two\n\n1. first\n2. second\n\n> note");
    expect(b[0]).toMatchObject({ type: "heading", level: 1, text: "Title" });
    expect(b[1]).toMatchObject({ type: "list", ordered: false, items: ["one", "two"] });
    expect(b[2]).toMatchObject({ type: "list", ordered: true, items: ["first", "second"] });
    expect(b[3]).toMatchObject({ type: "quote", text: "note" });
  });

  it("parses tables", () => {
    const b = parseBlocks("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(b[0]).toMatchObject({ type: "table", header: ["a", "b"], rows: [["1", "2"]] });
  });

  it("keeps an unterminated fence as code", () => {
    const b = parseBlocks("```\nstreaming…");
    expect(b[0]).toMatchObject({ type: "code", text: "streaming…" });
  });
});
