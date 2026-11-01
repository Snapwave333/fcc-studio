import { describe, expect, it } from "vitest";
import { storedToChat, summarizeThreads, threadOf } from "../store/useApp";
import type { StoredMessage } from "../lib/api";

const msg = (p: Partial<StoredMessage>): StoredMessage => ({
  id: crypto.randomUUID(),
  project_id: "p",
  session_id: "",
  role: "user",
  content: "",
  meta: "{}",
  created_at: "2026-01-01T00:00:00Z",
  ...p,
});

describe("conversation threads", () => {
  it("groups messages by thread and orders newest first", () => {
    const stored = [
      msg({ content: "first thread", meta: JSON.stringify({ thread: "t1" }), created_at: "2026-01-01T00:00:00Z" }),
      msg({ role: "assistant", content: JSON.stringify({ text: "ok" }), meta: JSON.stringify({ thread: "t1" }), created_at: "2026-01-01T00:00:01Z" }),
      msg({ content: "second thread", meta: JSON.stringify({ thread: "t2" }), created_at: "2026-01-02T00:00:00Z" }),
      msg({ content: "legacy", meta: "{}", created_at: "2025-12-01T00:00:00Z" }),
    ];
    const threads = summarizeThreads(stored);
    expect(threads.map((t) => t.id)).toEqual(["t2", "t1", "legacy"]);
    expect(threads[1]).toMatchObject({ title: "first thread", count: 2 });
    expect(threadOf(stored[3])).toBe("legacy");
  });

  it("restores assistant messages with tools and meta", () => {
    const m = storedToChat(
      msg({ role: "assistant", content: JSON.stringify({ text: "hi", tools: [{ id: "1", name: "Read", input: {} }], meta: "2 turns" }) })
    );
    expect(m.text).toBe("hi");
    expect(m.tools).toHaveLength(1);
    expect(m.meta).toBe("2 turns");
    expect(m.streaming).toBe(false);
  });

  it("tolerates malformed stored content", () => {
    expect(storedToChat(msg({ role: "assistant", content: "plain text" })).text).toBe("plain text");
    expect(threadOf(msg({ meta: "not json" }))).toBe("legacy");
  });
});
