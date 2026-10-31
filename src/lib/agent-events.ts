import { ToolActivity } from "../store/useApp";

export interface AgentEventState {
  sessionId: string;
  toolMap: Record<string, ToolActivity>;
}

export const emptyAgentEventState = (): AgentEventState => ({ sessionId: "", toolMap: {} });

export interface ProcessResult {
  messages: any[];
  finished: boolean;
  evState: AgentEventState;
}

function blockText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
  }
  return "";
}

export function processAgentEvent(evState: AgentEventState, event: any, messages: any[]): ProcessResult {
  const msgs = [...messages];
  let finished = false;
  const ev: AgentEventState = { sessionId: evState.sessionId, toolMap: { ...evState.toolMap } };
  const last = msgs.length > 0 ? msgs[msgs.length - 1] : undefined;
  const t = event?.type;

  if (t === "system" && event.subtype === "init") {
    if (event.session_id) ev.sessionId = event.session_id;
  } else if (t === "stream_event") {
    const e = event.event;
    if (e?.type === "content_block_delta" && e.delta?.type === "text_delta" && last?.streaming) {
      msgs[msgs.length - 1] = { ...last, text: (last.text ?? "") + (e.delta.text ?? "") };
    }
  } else if (t === "assistant") {
    const blocks: any[] = event.message?.content ?? [];
    if (last?.streaming) {
      let text = last.text;
      const tools: ToolActivity[] = [...last.tools];
      for (const b of blocks) {
        if (b.type === "text") {
          text += b.text ?? "";
        } else if (b.type === "tool_use") {
          const activity: ToolActivity = {
            id: b.id ?? crypto.randomUUID(),
            name: b.name ?? "tool",
            input: b.input ?? {},
          };
          tools.push(activity);
          ev.toolMap[activity.id] = activity;
        } else if (b.type === "thinking") {
          // thinking blocks are shown via activity log only
        }
      }
      msgs[msgs.length - 1] = { ...last, text, tools };
    }
  } else if (t === "user") {
    const blocks = event.message?.content;
    if (Array.isArray(blocks) && last?.streaming) {
      for (const b of blocks) {
        if (b.type === "tool_result" && b.tool_use_id) {
          const existing = ev.toolMap[b.tool_use_id];
          if (existing) {
            existing.result = blockText(b.content).slice(0, 4000);
            existing.isError = !!b.is_error;
          }
        }
      }
      const tools = last.tools.map((tl: ToolActivity) => ev.toolMap[tl.id] ?? tl);
      msgs[msgs.length - 1] = { ...last, tools };
    }
  } else if (t === "result") {
    finished = true;
    if (event.session_id) ev.sessionId = event.session_id;
    if (last?.streaming) {
      const finalText = typeof event.result === "string" && event.result.length > 0 ? event.result : last.text;
      msgs[msgs.length - 1] = { ...last, text: finalText, streaming: false };
    }
  }

  return { messages: msgs, finished, evState: ev };
}
