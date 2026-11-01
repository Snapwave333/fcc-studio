export interface ToolActivity {
  id: string;
  name: string;
  input: any;
  result?: string;
  isError?: boolean;
  parentId?: string;
}

export interface RunStats {
  costUsd?: number;
  durationMs?: number;
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  tools: ToolActivity[];
  streaming: boolean;
  ts: number;
  thinking?: string;
  error?: boolean;
  stats?: RunStats;
  meta?: string;
}

export interface AgentEventState {
  sessionId: string;
  model: string;
  toolMap: Record<string, ToolActivity>;
  streamed: Record<string, true>;
  currentMsgId: string | null;
  lastTextMsgId: string | null;
}

export const emptyAgentEventState = (): AgentEventState => ({
  sessionId: "",
  model: "",
  toolMap: {},
  streamed: {},
  currentMsgId: null,
  lastTextMsgId: null,
});

export interface ProcessResult {
  messages: ChatMessage[];
  finished: boolean;
  evState: AgentEventState;
  log?: string;
}

const MAX_RESULT_CHARS = 8000;

export function blockText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (c?.type === "text" ? c.text ?? "" : c?.type === "image" ? "[image]" : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function appendText(msg: ChatMessage, ev: AgentEventState, msgId: string | null, chunk: string): ChatMessage {
  if (!chunk) return msg;
  let text = msg.text;
  if (text && msgId && ev.lastTextMsgId && ev.lastTextMsgId !== msgId && !text.endsWith("\n\n")) {
    text += text.endsWith("\n") ? "\n" : "\n\n";
  }
  ev.lastTextMsgId = msgId;
  return { ...msg, text: text + chunk };
}

function addTool(msg: ChatMessage, ev: AgentEventState, block: any, parentId?: string): ChatMessage {
  const id: string = block.id ?? `tool-${Object.keys(ev.toolMap).length}`;
  if (ev.toolMap[id]) return msg;
  const activity: ToolActivity = { id, name: block.name ?? "tool", input: block.input ?? {} };
  if (parentId) activity.parentId = parentId;
  ev.toolMap[id] = activity;
  return { ...msg, tools: [...msg.tools, activity] };
}

export function processAgentEvent(evState: AgentEventState, event: any, messages: ChatMessage[]): ProcessResult {
  const msgs = [...messages];
  const ev: AgentEventState = {
    ...evState,
    toolMap: { ...evState.toolMap },
    streamed: { ...evState.streamed },
  };
  let finished = false;
  let log: string | undefined;
  const lastIndex = msgs.length - 1;
  let last = lastIndex >= 0 ? msgs[lastIndex] : undefined;
  const live = last?.role === "assistant" && last.streaming ? last : undefined;
  const t = event?.type;

  if (typeof event === "string") {
    log = event;
  } else if (t === "system") {
    if (event.subtype === "init") {
      if (event.session_id) ev.sessionId = event.session_id;
      if (event.model) ev.model = event.model;
      log = `[init] model=${event.model ?? "?"} tools=${Array.isArray(event.tools) ? event.tools.length : "?"}`;
    } else if (event.subtype) {
      log = `[system] ${event.subtype}`;
    }
  } else if (t === "stream_event" && live) {
    const e = event.event;
    if (!event.parent_tool_use_id && e) {
      if (e.type === "message_start") {
        ev.currentMsgId = e.message?.id ?? null;
      } else if (e.type === "content_block_delta") {
        const msgId = ev.currentMsgId;
        if (e.delta?.type === "text_delta") {
          last = appendText(live, ev, msgId, e.delta.text ?? "");
          if (msgId) ev.streamed[msgId] = true;
          msgs[lastIndex] = last;
        } else if (e.delta?.type === "thinking_delta") {
          msgs[lastIndex] = { ...live, thinking: (live.thinking ?? "") + (e.delta.thinking ?? "") };
          if (msgId) ev.streamed[msgId] = true;
        }
      }
    }
  } else if (t === "assistant" && live) {
    const parentId: string | undefined = event.parent_tool_use_id ?? undefined;
    const msgId: string | null = event.message?.id ?? null;
    const alreadyStreamed = !!(msgId && ev.streamed[msgId]);
    const blocks: any[] = Array.isArray(event.message?.content) ? event.message.content : [];
    let next = live;
    for (const b of blocks) {
      if (b?.type === "tool_use") {
        next = addTool(next, ev, b, parentId);
      } else if (parentId) {
        continue;
      } else if (b?.type === "text" && !alreadyStreamed) {
        next = appendText(next, ev, msgId, b.text ?? "");
      } else if (b?.type === "thinking" && !alreadyStreamed && b.thinking) {
        next = { ...next, thinking: (next.thinking ?? "") + b.thinking };
      }
    }
    msgs[lastIndex] = next;
  } else if (t === "user" && live) {
    const blocks = event.message?.content;
    if (Array.isArray(blocks)) {
      let touched = false;
      for (const b of blocks) {
        if (b?.type === "tool_result" && b.tool_use_id && ev.toolMap[b.tool_use_id]) {
          ev.toolMap[b.tool_use_id] = {
            ...ev.toolMap[b.tool_use_id],
            result: blockText(b.content).slice(0, MAX_RESULT_CHARS) || "(no output)",
            isError: !!b.is_error,
          };
          touched = true;
        }
      }
      if (touched) {
        msgs[lastIndex] = { ...live, tools: live.tools.map((tl) => ev.toolMap[tl.id] ?? tl) };
      }
    }
  } else if (t === "result") {
    finished = true;
    if (event.session_id) ev.sessionId = event.session_id;
    const isError = !!event.is_error || (typeof event.subtype === "string" && event.subtype.startsWith("error"));
    const stats: RunStats = {
      costUsd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : undefined,
      durationMs: typeof event.duration_ms === "number" ? event.duration_ms : undefined,
      turns: typeof event.num_turns === "number" ? event.num_turns : undefined,
      inputTokens: event.usage?.input_tokens,
      outputTokens: event.usage?.output_tokens,
      model: ev.model || undefined,
    };
    if (live) {
      let text = live.text;
      const resultText = typeof event.result === "string" ? event.result : "";
      if (!text.trim() && resultText) text = resultText;
      if (isError) {
        const reason = resultText && resultText !== text ? resultText : event.subtype ?? "error";
        text = `${text}${text ? "\n\n" : ""}⚠ Run ended with an error: ${reason}`;
      }
      msgs[lastIndex] = { ...live, text, streaming: false, error: isError, stats };
    }
    log = `[result] ${event.subtype ?? (isError ? "error" : "success")}${
      stats.durationMs ? ` in ${(stats.durationMs / 1000).toFixed(1)}s` : ""
    }`;
  }

  return { messages: msgs, finished, evState: ev, log };
}

export function finalizeStreaming(messages: ChatMessage[], exitCode: number): ChatMessage[] {
  const lastIndex = messages.length - 1;
  const last = messages[lastIndex];
  if (!last || !last.streaming) return messages;
  const failed = exitCode !== 0;
  const text =
    failed && !last.error
      ? `${last.text}${last.text ? "\n\n" : ""}⚠ Agent process exited with code ${exitCode}`
      : last.text;
  const out = [...messages];
  out[lastIndex] = { ...last, text, streaming: false, error: last.error || failed };
  return out;
}

export function formatStats(stats?: RunStats): string {
  if (!stats) return "";
  const parts: string[] = [];
  if (stats.durationMs !== undefined) parts.push(`${(stats.durationMs / 1000).toFixed(1)}s`);
  if (stats.turns !== undefined) parts.push(`${stats.turns} turn${stats.turns === 1 ? "" : "s"}`);
  if (stats.inputTokens !== undefined || stats.outputTokens !== undefined) {
    parts.push(`${compact(stats.inputTokens ?? 0)} in · ${compact(stats.outputTokens ?? 0)} out`);
  }
  if (stats.costUsd !== undefined && stats.costUsd > 0) parts.push(`$${stats.costUsd.toFixed(4)}`);
  if (stats.model) parts.push(stats.model);
  return parts.join(" · ");
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function toolSummary(tool: ToolActivity): string {
  const i = tool.input ?? {};
  const raw =
    i.command ??
    i.file_path ??
    i.notebook_path ??
    i.path ??
    i.pattern ??
    i.url ??
    i.query ??
    i.description ??
    i.prompt ??
    Object.values(i).find((v) => typeof v === "string") ??
    "";
  return String(raw).replace(/\s+/g, " ").slice(0, 160);
}
