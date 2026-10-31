import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronRight,
  CircleStop,
  PanelLeft,
  PanelRight,
  Plus,
  Send,
  Sparkles,
  Terminal as TerminalIcon,
  Wrench,
  X,
} from "lucide-react";
import { useApp, ChatMessage, ToolActivity } from "../../store/useApp";

function ToolBlock({ tool }: { tool: ToolActivity }) {
  const [open, setOpen] = useState(false);
  const icon =
    tool.name === "Bash" || tool.name === "bash" ? (
      <TerminalIcon size={12} />
    ) : (
      <Wrench size={12} />
    );
  const summary =
    tool.input?.command ??
    tool.input?.file_path ??
    tool.input?.path ??
    tool.input?.pattern ??
    tool.input?.description ??
    Object.values(tool.input ?? {})[0] ??
    "";
  return (
    <div className="rounded-lg border border-[#26262f] bg-bg2 text-[11.5px]">
      <button
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={tool.isError ? "text-err" : "text-fuchsia2"}>
          {tool.isError ? <AlertTriangle size={12} /> : icon}
        </span>
        <span className="font-medium text-text2">{tool.name}</span>
        <span className="min-w-0 flex-1 truncate text-muted">{String(summary).slice(0, 140)}</span>
        {tool.result ? (
          <span className={tool.isError ? "text-err" : "text-ok"}>{tool.isError ? "failed" : "done"}</span>
        ) : (
          <span className="text-muted">running…</span>
        )}
        <ChevronRight size={12} className={`text-muted transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="border-t border-[#26262f] px-2.5 py-1.5">
          <div className="mb-1 text-[10.5px] uppercase tracking-wide text-muted">input</div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all text-[11px] text-text2">
            {JSON.stringify(tool.input, null, 2)}
          </pre>
          {tool.result && (
            <>
              <div className="mb-1 mt-2 text-[10.5px] uppercase tracking-wide text-muted">result</div>
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all text-[11px] text-muted">
                {tool.result}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MessageView({ msg }: { msg: ChatMessage }) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-select px-3.5 py-2 text-[13px] leading-relaxed">
          {msg.text}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {msg.tools.length > 0 && (
        <div className="space-y-1">
          {msg.tools.map((t) => (
            <ToolBlock key={t.id} tool={t} />
          ))}
        </div>
      )}
      {msg.text && (
        <div className="md whitespace-pre-wrap break-words text-[13px] leading-relaxed text-text">{msg.text}</div>
      )}
      {msg.streaming && !msg.text && msg.tools.length === 0 && (
        <div className="flex items-center gap-2 text-[12px] text-muted">
          <Sparkles size={13} className="animate-pulse text-fuchsia" />
          thinking…
        </div>
      )}
    </div>
  );
}

export default function AgentPanel({
  leftOpen,
  rightOpen,
  onToggleLeft,
  onToggleRight,
}: {
  leftOpen: boolean;
  rightOpen: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
}) {
  const messages = useApp((s) => s.messages);
  const running = useApp((s) => s.running);
  const project = useApp((s) => s.activeProject());
  const sessionId = useApp((s) => s.sessionId);
  const pendingElement = useApp((s) => s.pendingElement);
  const activityLog = useApp((s) => s.activityLog);
  const inspectorOpen = useApp((s) => s.inspectorOpen);
  const sendMessage = useApp((s) => s.sendMessage);
  const stopRun = useApp((s) => s.stopRun);
  const newSession = useApp((s) => s.newSession);

  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const submit = () => {
    if (!draft.trim() || running || !project) return;
    const text = draft;
    setDraft("");
    sendMessage(text);
  };

  const allTools: ToolActivity[] = messages.flatMap((m) => m.tools);

  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[#22222c] px-3">
        {!leftOpen && (
          <button className="btn btn-ghost px-1.5" onClick={onToggleLeft} title="Show left panel">
            <PanelLeft size={15} />
          </button>
        )}
        <span className="text-[12.5px] font-semibold">{project ? project.name : "FCC Studio"}</span>
        {sessionId && <span className="chip">session {sessionId.slice(0, 8)}</span>}
        <span className="min-w-0 flex-1" />
        {messages.length > 0 && (
          <button className="btn btn-ghost" onClick={newSession} title="Start a fresh session">
            <Plus size={13} /> New session
          </button>
        )}
        {!rightOpen && (
          <button className="btn btn-ghost px-1.5" onClick={onToggleRight} title="Show right panel">
            <PanelRight size={15} />
          </button>
        )}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <div className="mx-auto mt-24 max-w-md text-center">
            <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-elev">
              <Sparkles size={20} className="text-fuchsia" />
            </div>
            <h2 className="mb-1 text-[15px] font-semibold">What should we build?</h2>
            <p className="text-[12.5px] leading-relaxed text-muted">
              Describe what you want in plain language. The agent plans, writes, runs and tests the
              code in this project folder, and you watch it happen live.
            </p>
          </div>
        )}
        {messages.map((m) => (
          <MessageView key={m.id} msg={m} />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 px-3 pb-3">
        {inspectorOpen && allTools.length > 0 && (
          <div className="mb-2 max-h-40 space-y-1 overflow-y-auto rounded-xl border border-[#22222c] bg-panel p-2">
            <div className="px-1 pb-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted">
              activity · {allTools.length} tool calls
            </div>
            {allTools.slice(-12).map((t) => (
              <div key={t.id} className="flex items-center gap-2 px-1 text-[11.5px]">
                <span className={t.isError ? "text-err" : t.result ? "text-ok" : "text-fuchsia2"}>
                  {t.isError ? "✕" : t.result ? "✓" : "◌"}
                </span>
                <span className="text-text2">{t.name}</span>
                <span className="min-w-0 flex-1 truncate text-muted">
                  {String(
                    t.input?.command ?? t.input?.file_path ?? t.input?.path ?? t.input?.pattern ?? ""
                  )}
                </span>
              </div>
            ))}
            {activityLog.slice(-3).map((l, i) => (
              <div key={i} className="px-1 text-[11px] text-muted">
                {l}
              </div>
            ))}
          </div>
        )}

        {pendingElement && (
          <div className="mb-2 flex items-center gap-2 rounded-lg bg-select px-3 py-1.5 text-[12px]">
            <span className="text-fuchsia2">◎</span>
            <span className="min-w-0 flex-1 truncate text-text2">
              {`<${pendingElement.tag}> ${pendingElement.text.slice(0, 60)} — included with next message`}
            </span>
            <button onClick={() => useApp.getState().setPendingElement(null)} className="text-muted hover:text-text">
              <X size={13} />
            </button>
          </div>
        )}

        <div className="rounded-2xl border border-[#2c2c38] bg-panel p-2 focus-within:border-fuchsia">
          <textarea
            className="max-h-40 w-full resize-none bg-transparent px-2 py-1.5 text-[13px] text-text outline-none placeholder:text-muted"
            rows={2}
            placeholder={
              project
                ? running
                  ? "Agent is working…"
                  : "Describe what to build, change or fix…"
                : "Create or select a project first"
            }
            value={draft}
            disabled={!project}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="flex items-center gap-1 px-1">
            <span className="text-[10.5px] text-muted">Enter to send · Shift+Enter for newline</span>
            <span className="min-w-0 flex-1" />
            {running ? (
              <button className="btn btn-danger" onClick={stopRun} title="Stop the agent immediately">
                <CircleStop size={14} /> Stop
              </button>
            ) : (
              <button className="btn btn-primary" onClick={submit} disabled={!project || !draft.trim()}>
                <Send size={13} /> Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
