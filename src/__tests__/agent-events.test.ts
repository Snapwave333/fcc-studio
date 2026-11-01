import { describe, expect, it } from "vitest";
import { ChatMessage, emptyAgentEventState, formatResultMeta, joinText, processAgentEvent } from "../lib/agent-events";

const live = (): ChatMessage[] => [
  { id: "u", role: "user", text: "hi", tools: [], streaming: false, ts: 0 },
  { id: "a", role: "assistant", text: "", tools: [], streaming: true, ts: 0 },
];

function run(events: any[]) {
  let st = emptyAgentEventState();
  let msgs = live();
  let finished = false;
  for (const e of events) {
    const r = processAgentEvent(st, e, msgs);
    st = r.evState;
    msgs = r.messages;
    finished = finished || r.finished;
  }
  return { st, msgs, finished, last: msgs[msgs.length - 1] };
}

const delta = (text: string) => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
const assistant = (content: any[]) => ({ type: "assistant", message: { content } });

describe("processAgentEvent", () => {
  it("captures the session id from init", () => {
    const { st } = run([{ type: "system", subtype: "init", session_id: "s-1", model: "m" }]);
    expect(st.sessionId).toBe("s-1");
    expect(st.model).toBe("m");
  });

  it("does not duplicate text when partial deltas are followed by the full assistant message", () => {
    const { last } = run([
      { type: "stream_event", event: { type: "message_start" } },
      delta("Hello "),
      delta("world"),
      assistant([{ type: "text", text: "Hello world" }]),
    ]);
    expect(last.text).toBe("Hello world");
  });

  it("keeps text from multiple turns separated", () => {
    const { last } = run([
      delta("Looking at files"),
      assistant([{ type: "text", text: "Looking at files" }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } }]),
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
      { type: "stream_event", event: { type: "message_start" } },
      delta("Done."),
      assistant([{ type: "text", text: "Done." }]),
    ]);
    expect(last.text).toBe("Looking at files\n\nDone.");
    expect(last.tools).toHaveLength(1);
    expect(last.tools[0].result).toBe("ok");
  });

  it("does not mutate previous tool objects", () => {
    let st = emptyAgentEventState();
    let msgs = live();
    let r = processAgentEvent(st, assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]), msgs);
    const before = r.messages[1].tools[0];
    r = processAgentEvent(r.evState, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "x" }], is_error: true }] } }, r.messages);
    expect(before.result).toBeUndefined();
    expect(r.messages[1].tools[0].isError).toBe(true);
  });

  it("finalizes on result with stats and falls back to result text", () => {
    const { last, finished, st } = run([
      { type: "system", subtype: "init", session_id: "s", model: "claude-x" },
      { type: "result", subtype: "success", result: "Final answer", session_id: "s2", num_turns: 3, duration_ms: 4200, total_cost_usd: 0.0123 },
    ]);
    expect(finished).toBe(true);
    expect(last.streaming).toBe(false);
    expect(last.text).toBe("Final answer");
    expect(last.meta).toContain("3 turns");
    expect(last.meta).toContain("4.2s");
    expect(st.sessionId).toBe("s2");
  });

  it("marks error results", () => {
    const { last } = run([{ type: "result", subtype: "error_max_turns", is_error: true }]);
    expect(last.error).toBe(true);
    expect(last.text).toContain("error_max_turns");
  });

  it("ignores events when nothing is streaming", () => {
    const msgs: ChatMessage[] = [{ id: "a", role: "assistant", text: "old", tools: [], streaming: false, ts: 0 }];
    const r = processAgentEvent(emptyAgentEventState(), delta("new"), msgs);
    expect(r.messages[0].text).toBe("old");
  });
});

describe("helpers", () => {
  it("joins text blocks with a blank line", () => {
    expect(joinText("", "b")).toBe("b");
    expect(joinText("a\n", "\nb")).toBe("a\n\nb");
  });

  it("formats usage tokens", () => {
    expect(formatResultMeta({ usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 } }, "")).toContain("15 in / 7 out");
  });
});
