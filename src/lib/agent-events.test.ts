import { describe, expect, it } from "vitest";
import {
  ChatMessage,
  emptyAgentEventState,
  finalizeStreaming,
  formatStats,
  processAgentEvent,
  toolSummary,
} from "./agent-events";

function live(): ChatMessage[] {
  return [
    { id: "u", role: "user", text: "hi", tools: [], streaming: false, ts: 0 },
    { id: "a", role: "assistant", text: "", tools: [], streaming: true, ts: 0 },
  ];
}

function run(events: any[]) {
  let ev = emptyAgentEventState();
  let messages = live();
  let finished = false;
  const logs: string[] = [];
  for (const e of events) {
    const r = processAgentEvent(ev, e, messages);
    ev = r.evState;
    messages = r.messages;
    finished = finished || r.finished;
    if (r.log) logs.push(r.log);
  }
  return { ev, messages, finished, logs, last: messages[messages.length - 1] };
}

const init = { type: "system", subtype: "init", session_id: "sess-1", model: "claude-x", tools: ["Bash", "Read"] };
const start = (id: string) => ({ type: "stream_event", event: { type: "message_start", message: { id } } });
const delta = (text: string) => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
const assistant = (id: string, content: any[], parent: string | null = null) => ({
  type: "assistant",
  parent_tool_use_id: parent,
  message: { id, content },
});

describe("processAgentEvent", () => {
  it("captures the session id and model from init", () => {
    const { ev, logs } = run([init]);
    expect(ev.sessionId).toBe("sess-1");
    expect(ev.model).toBe("claude-x");
    expect(logs[0]).toContain("tools=2");
  });

  it("does not duplicate text that was already streamed as deltas", () => {
    const { last } = run([init, start("m1"), delta("Hel"), delta("lo"), assistant("m1", [{ type: "text", text: "Hello" }])]);
    expect(last.text).toBe("Hello");
  });

  it("uses complete assistant text when partial messages are not streamed", () => {
    const { last } = run([init, assistant("m1", [{ type: "text", text: "Hello" }])]);
    expect(last.text).toBe("Hello");
  });

  it("separates text from consecutive assistant turns", () => {
    const { last } = run([
      start("m1"),
      delta("Looking at files."),
      assistant("m1", [{ type: "text", text: "Looking at files." }]),
      start("m2"),
      delta("Done."),
    ]);
    expect(last.text).toBe("Looking at files.\n\nDone.");
  });

  it("tracks tool calls and attaches results immutably", () => {
    const before = run([init, assistant("m1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }])]);
    const toolBefore = before.last.tools[0];
    const r = processAgentEvent(
      before.ev,
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a.txt" }] }] } },
      before.messages
    );
    const tool = r.messages[1].tools[0];
    expect(tool.result).toBe("a.txt");
    expect(tool.isError).toBe(false);
    expect(toolBefore.result).toBeUndefined();
  });

  it("marks failing tool results", () => {
    const { last } = run([
      assistant("m1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "false" } }]),
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "exit 1", is_error: true }] } },
    ]);
    expect(last.tools[0].isError).toBe(true);
    expect(last.tools[0].result).toBe("exit 1");
  });

  it("keeps subagent text out of the main reply but records nested tools", () => {
    const { last } = run([
      assistant("m1", [{ type: "tool_use", id: "task1", name: "Task", input: { description: "explore" } }]),
      assistant("sub1", [{ type: "text", text: "subagent chatter" }, { type: "tool_use", id: "t2", name: "Grep", input: { pattern: "x" } }], "task1"),
    ]);
    expect(last.text).toBe("");
    expect(last.tools.map((t) => t.id)).toEqual(["task1", "t2"]);
    expect(last.tools[1].parentId).toBe("task1");
  });

  it("does not overwrite a multi-turn reply with the final result text", () => {
    const { last, finished } = run([
      start("m1"),
      delta("First part."),
      start("m2"),
      delta("Summary."),
      { type: "result", subtype: "success", result: "Summary.", session_id: "sess-2", duration_ms: 4200, num_turns: 3, total_cost_usd: 0.0123, usage: { input_tokens: 1500, output_tokens: 300 } },
    ]);
    expect(finished).toBe(true);
    expect(last.text).toBe("First part.\n\nSummary.");
    expect(last.streaming).toBe(false);
    expect(last.stats?.turns).toBe(3);
    expect(formatStats(last.stats)).toBe("4.2s · 3 turns · 1.5k in · 300 out · $0.0123");
  });

  it("falls back to result text when nothing streamed", () => {
    const { last } = run([{ type: "result", subtype: "success", result: "All done" }]);
    expect(last.text).toBe("All done");
  });

  it("surfaces error results", () => {
    const { last } = run([start("m1"), delta("Trying."), { type: "result", subtype: "error_max_turns", is_error: true }]);
    expect(last.error).toBe(true);
    expect(last.text).toContain("Trying.");
    expect(last.text).toContain("error_max_turns");
  });

  it("collects thinking separately from the reply", () => {
    const { last } = run([
      start("m1"),
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "plan" } } },
      delta("Answer"),
      assistant("m1", [{ type: "thinking", thinking: "plan" }, { type: "text", text: "Answer" }]),
    ]);
    expect(last.thinking).toBe("plan");
    expect(last.text).toBe("Answer");
  });

  it("ignores events when nothing is streaming", () => {
    const messages: ChatMessage[] = [{ id: "a", role: "assistant", text: "old", tools: [], streaming: false, ts: 0 }];
    const r = processAgentEvent(emptyAgentEventState(), assistant("m", [{ type: "text", text: "new" }]), messages);
    expect(r.messages[0].text).toBe("old");
  });

  it("logs non-json output lines", () => {
    const r = processAgentEvent(emptyAgentEventState(), "plain stdout line", live());
    expect(r.log).toBe("plain stdout line");
  });
});

describe("finalizeStreaming", () => {
  it("closes the live message and notes a non-zero exit", () => {
    const out = finalizeStreaming(live(), 2);
    expect(out[1].streaming).toBe(false);
    expect(out[1].error).toBe(true);
    expect(out[1].text).toContain("code 2");
  });

  it("leaves finished conversations untouched", () => {
    const msgs = live();
    msgs[1] = { ...msgs[1], streaming: false };
    expect(finalizeStreaming(msgs, 1)).toBe(msgs);
  });
});

describe("toolSummary", () => {
  it("prefers the most descriptive input field", () => {
    expect(toolSummary({ id: "1", name: "Bash", input: { command: "npm   test", description: "run" } })).toBe("npm test");
    expect(toolSummary({ id: "2", name: "Read", input: { file_path: "/a/b.ts" } })).toBe("/a/b.ts");
    expect(toolSummary({ id: "3", name: "X", input: { foo: 1, bar: "baz" } })).toBe("baz");
  });
});
