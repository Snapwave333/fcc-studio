export interface ToolActivity {
  id: string;
  name: string;
  input: any;
  result?: string;
  isError?: boolean;
}

export type MessagePart = { kind: "text"; text: string } | { kind: "tool"; id: string };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  tools: ToolActivity[];
  streaming: boolean;
  ts: number;
  meta?: string;
  thinking?: boolean;
  error?: boolean;
  parts?: MessagePart[];
}

export interface AgentEventState {
  sessionId: string;
  model: string;
  committed: string;
  partial: string;
  segments: MessagePart[];
}

export const emptyAgentEventState = (): AgentEventState => ({
  sessionId: "",
  model: "",
  committed: "",
  partial: "",
  segments: [],
});

export function livePart(segments: MessagePart[], partial: string): MessagePart[] {
  return partial ? [...segments, { kind: "text", text: partial }] : segments;
}

export interface ProcessResult {
  messages: ChatMessage[];
  finished: boolean;
  evState: AgentEventState;
}

export function joinText(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return a.replace(/\s+$/, "") + "\n\n" + b.replace(/^\s+/, "");
}

export function blockText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text ?? "")
      .join("\n");
  }
  return "";
}

export function formatResultMeta(event: any, model: string): string {
  const parts: string[] = [];
  if (model) parts.push(model);
  if (typeof event.num_turns === "number") parts.push(`${event.num_turns} turn${event.num_turns === 1 ? "" : "s"}`);
  if (typeof event.duration_ms === "number") parts.push(`${(event.duration_ms / 1000).toFixed(1)}s`);
  if (typeof event.total_cost_usd === "number" && event.total_cost_usd > 0) parts.push(`$${event.total_cost_usd.toFixed(4)}`);
  const usage = event.usage;
  if (usage && typeof usage.output_tokens === "number") {
    const input = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    parts.push(`${input.toLocaleString()} in / ${usage.output_tokens.toLocaleString()} out`);
  }
  return parts.join(" · ");
}

export function processAgentEvent(evState: AgentEventState, event: any, messages: ChatMessage[]): ProcessResult {
  const msgs = messages.slice();
  let finished = false;
  const ev: AgentEventState = { ...evState, segments: evState.segments ?? [] };
  const lastIdx = msgs.length - 1;
  const last = lastIdx >= 0 ? msgs[lastIdx] : undefined;
  const live = last && last.role === "assistant" && last.streaming ? last : undefined;
  const t = event?.type;

  const render = (patch: Partial<ChatMessage>) => {
    if (!live) return;
    msgs[lastIdx] = { ...live, text: joinText(ev.committed, ev.partial), parts: livePart(ev.segments, ev.partial), ...patch };
  };

  if (t === "system" && event.subtype === "init") {
    if (event.session_id) ev.sessionId = event.session_id;
    if (event.model) ev.model = event.model;
  } else if (t === "stream_event") {
    const e = event.event;
    if (e?.type === "message_start") {
      ev.partial = "";
    } else if (e?.type === "content_block_start" && e.content_block?.type === "thinking") {
      render({ thinking: true });
    } else if (e?.type === "content_block_delta") {
      if (e.delta?.type === "text_delta") {
        ev.partial += e.delta.text ?? "";
        render({ thinking: false });
      } else if (e.delta?.type === "thinking_delta") {
        render({ thinking: true });
      }
    }
  } else if (t === "assistant") {
    const blocks: any[] = event.message?.content ?? [];
    const text = blocks
      .filter((b) => b?.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    ev.committed = joinText(ev.committed, text);
    ev.partial = "";
    const segments = ev.segments.slice();
    if (text.trim()) segments.push({ kind: "text", text });
    const tools = live ? live.tools.slice() : [];
    for (const b of blocks) {
      if (b?.type === "tool_use") {
        const id = b.id ?? crypto.randomUUID();
        if (!tools.some((x) => x.id === id)) {
          tools.push({ id, name: b.name ?? "tool", input: b.input ?? {} });
          segments.push({ kind: "tool", id });
        }
      }
    }
    ev.segments = segments;
    if (live) render({ tools, thinking: false });
  } else if (t === "user") {
    const blocks = event.message?.content;
    if (Array.isArray(blocks) && live) {
      const results = new Map<string, { result: string; isError: boolean }>();
      for (const b of blocks) {
        if (b?.type === "tool_result" && b.tool_use_id) {
          results.set(b.tool_use_id, { result: blockText(b.content).slice(0, 8000), isError: !!b.is_error });
        }
      }
      if (results.size > 0) {
        const tools = live.tools.map((tl) => (results.has(tl.id) ? { ...tl, ...results.get(tl.id)! } : tl));
        render({ tools });
      }
    }
  } else if (t === "result") {
    finished = true;
    if (event.session_id) ev.sessionId = event.session_id;
    if (live) {
      const fallback = typeof event.result === "string" ? event.result : "";
      const isError = !!event.is_error || (typeof event.subtype === "string" && event.subtype.startsWith("error"));
      let text = joinText(ev.committed, ev.partial) || fallback;
      if (isError && !text) text = `⚠ Run ended: ${event.subtype ?? "error"}`;
      let parts = livePart(ev.segments, ev.partial);
      if (!parts.some((p) => p.kind === "text") && text) parts = [...parts, { kind: "text", text }];
      msgs[lastIdx] = {
        ...live,
        text,
        parts,
        streaming: false,
        thinking: false,
        error: isError,
        meta: formatResultMeta(event, ev.model),
      };
    }
    ev.committed = "";
    ev.partial = "";
    ev.segments = [];
  }

  return { messages: msgs, finished, evState: ev };
}
