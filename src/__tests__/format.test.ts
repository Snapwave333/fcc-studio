import { describe, expect, it } from "vitest";
import { baseName, joinPath, relPath, relativeTime } from "../lib/format";

describe("paths", () => {
  it("computes relative paths on both separators", () => {
    expect(relPath("/home/u/app", "/home/u/app/src/a.ts")).toBe("src/a.ts");
    expect(relPath("C:\\dev\\app", "C:\\dev\\app\\src\\a.ts")).toBe("src\\a.ts");
    expect(relPath("/home/u/app", "/elsewhere/x")).toBe("/elsewhere/x");
  });

  it("joins with the native separator", () => {
    expect(joinPath("/a/b/", "c.ts")).toBe("/a/b/c.ts");
    expect(joinPath("C:\\a", "c.ts")).toBe("C:\\a\\c.ts");
  });

  it("extracts base names", () => {
    expect(baseName("/a/b/")).toBe("b");
    expect(baseName("C:\\x\\y.txt")).toBe("y.txt");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  it("formats recent times", () => {
    expect(relativeTime("2026-01-01T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-01-01T11:30:00Z", now)).toBe("30m ago");
    expect(relativeTime("2026-01-01T07:00:00Z", now)).toBe("5h ago");
    expect(relativeTime("2025-12-29T12:00:00Z", now)).toBe("3d ago");
    expect(relativeTime("garbage", now)).toBe("");
  });
});
