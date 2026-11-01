import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  Brain,
  ChevronRight,
  CircleStop,
  History,
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
import { formatStats, toolSummary } from "../../lib/agent-events";
import Markdown from "./Markdown";

const ToolBlock = memo(function ToolBlock({ tool }: { tool: ToolActivity }) {
  const [open, setOpen] = useState(false);
  const isShell = /^bash$/i.test(tool.name) || tool.name === "PowerShell";
  const icon = isShell ? <TerminalIcon size={12} /> : <Wrench size={12} />;
  return (
    <div className={`rounded-lg border border-[#26262f] bg-bg2 text-[11.5px] ${tool.parentId ? "ml-4 opacity-90" : ""}`}>
      <button className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left" onClick={() => setOpen((v) => !v)}>
        <span className={tool.isError ? "text-err" : "text-fuchsia2"}>{tool.isError ? <AlertTriangle size={12} /> : icon}</span>
        <span className="font-medium text-text2">{tool.name}</span>
        <span className="min-w-0 flex-1 truncate text-muted">{toolSummary(tool)}</span>
        {tool.result !== undefined ? (
          <span className={tool.isError ? "text-err" : "text-ok"}>{tool.isError ? "failed" : "done"}</span>
        ) : (
          <span className="animate-pulse text-muted">running…</span>
        )}
        <ChevronRight size={12} className={`text-muted transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="border-t border-[#26262f] px-2.5 py-1.5">
          <div className="mb-1 text-[10.5px] uppercase tracking-wide text-muted">input</div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all text-[11px] text-text2">
            {JSON.stringify(tool.input, null, 2)}
          </pre>
          {tool.result !== undefined && (
            <>
              <div className="mb-1 mt-2 text-[10.5px] uppercase tracking-wide text-muted">result</div>
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all text-[11px] text-muted">{tool.result}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
});

function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-[#22222c] bg-bg2/60 text-[11.5px]">
      <button className="flex w-full items-center gap-2 px-2.5 py-1 text-left text-muted" onClick={() => setOpen((v) => !v)}>
        <Brain size={12} className={live ? "animate-pulse text-fuchsia2" : ""} />
        <span>{live ? "thinking…" : "thought process"}</span>
        <span className="min-w-0 flex-1" />
        <ChevronRight size={12} className={`transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-[#22222c] px-2.5 py-1.5 text-[11px] leading-relaxed text-muted">
          {text}
        </pre>
      )}
    </div>
  );
}

const MessageView = memo(function MessageView({ msg }: { msg: ChatMessage }) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-select px-3.5 py-2 text-[13px] leading-relaxed">
          {msg.text}
        </div>
      </div>
    );
  }
  const stats = formatStats(msg.stats);
  return (
    <div className="space-y-1.5">
      {msg.thinking && <Thinking text={msg.thinking} live={msg.streaming && !msg.text} />}
      {msg.tools.length > 0 && (
        <div className="space-y-1">
          {msg.tools.map((t) => (
            <ToolBlock key={t.id} tool={t} />
          ))}
        </div>
      )}
      {msg.text && (
        <div className={msg.error ? "rounded-lg border border-err/30 bg-err/5 px-3 py-2" : ""}>
          <Markdown text={msg.text} />
          {msg.streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-fuchsia align-middle" />}
        </div>
      )}
      {msg.streaming && !msg.text && msg.tools.length === 0 && !msg.thinking && (
        <div className="flex items-center gap-2 text-[12px] text-muted">
          <Sparkles size={13} className="animate-pulse text-fuchsia" />
          starting agent…
        </div>
      )}
      {!msg.streaming && stats && <div className="text-[10.5px] text-muted">{stats}</div>}
    </div>
  );
});

function SessionPicker({ onClose }: { onClose: () => void }) {
  const sessions = useApp((s) => s.sessions);
  const sessionId = useApp((s) => s.sessionId);
  const openSession = useApp((s) => s.openSession);
  return (
    <div className="absolute right-2 top-10 z-40 max-h-80 w-80 overflow-y-auto rounded-xl border border-[#2c2c38] bg-elev p-1.5 shadow-2xl">
      <div className="px-2 pb-1 text-[10.5px] uppercase tracking-wider text-muted">recent sessions</div>
      {sessions.length === 0 && <div className="px-2 py-1.5 text-[12px] text-muted">No saved sessions yet.</div>}
      {sessions.map((s) => (
        <button
          key={s.session_id}
          className={`block w-full rounded-lg px-2 py-1.5 text-left hover:bg-panel ${s.session_id === sessionId ? "bg-panel" : ""}`}
          onClick={async () => {
            onClose();
            await openSession(s.session_id);
          }}
        >
          <div className="truncate text-[12px] text-text2">{s.first_prompt || "(no prompt)"}</div>
          <div className="text-[10.5px] text-muted">
            {new Date(s.last_at).toLocaleString()} · {s.messages} messages
          </div>
        </button>
      ))}
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
  const sessions = useApp((s) => s.sessions);
  const pendingElement = useApp((s) => s.pendingElement);
  const pendingSkill = useApp((s) => s.pendingSkill);
  const activityLog = useApp((s) => s.activityLog);
  const inspectorOpen = useApp((s) => s.inspectorOpen);
  const setInspectorOpen = useApp((s) => s.setInspectorOpen);
  const sendMessage = useApp((s) => s.sendMessage);
  const stopRun = useApp((s) => s.stopRun);
  const newSession = useApp((s) => s.newSession);
  const setPendingSkill = useApp((s) => s.setPendingSkill);

  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pinned, setPinned] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinned) el.scrollTop = el.scrollHeight;
  }, [messages, pinned]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [draft]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && running) {
        e.preventDefault();
        stopRun();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running, stopRun]);

  useEffect(() => {
    setPinned(true);
    inputRef.current?.focus();
  }, [project?.id, sessionId]);

  const submit = () => {
    if (!draft.trim() || running || !project) return;
    const text = draft;
    setHistory((h) => [text, ...h.filter((x) => x !== text)].slice(0, 50));
    setHistoryIdx(-1);
    setDraft("");
    setPinned(true);
    sendMessage(text);
  };

  const live = messages.at(-1)?.streaming ? messages.at(-1) : undefined;
  const liveTools: ToolActivity[] = live?.tools ?? [];

  return (
    <div className="relative flex h-full flex-col bg-bg">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[#22222c] px-3">
        {!leftOpen && (
          <button className="btn btn-ghost px-1.5" onClick={onToggleLeft} title="Show left panel">
            <PanelLeft size={15} />
          </button>
        )}
        <span className="truncate text-[12.5px] font-semibold">{project ? project.name : "Serenity"}</span>
        {sessionId && (
          <span className="chip" title={sessionId}>
            session {sessionId.slice(0, 8)}
          </span>
        )}
        <span className="min-w-0 flex-1" />
        {project && (
          <button
            className={`btn btn-ghost px-2 ${pickerOpen ? "bg-elev" : ""}`}
            onClick={() => setPickerOpen((v) => !v)}
            title="Session history"
            disabled={running}
          >
            <History size={13} /> {sessions.length > 0 ? sessions.length : ""}
          </button>
        )}
        {messages.length > 0 && (
          <button className="btn btn-ghost" onClick={newSession} title="Start a fresh session" disabled={running}>
            <Plus size={13} /> New session
          </button>
        )}
        {!rightOpen && (
          <button className="btn btn-ghost px-1.5" onClick={onToggleRight} title="Show right panel">
            <PanelRight size={15} />
          </button>
        )}
      </div>
      {pickerOpen && <SessionPicker onClose={() => setPickerOpen(false)} />}

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4"
        onScroll={(e) => {
          const el = e.currentTarget;
          setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
        }}
      >
        {messages.length === 0 && (
          <div className="mx-auto mt-24 max-w-md text-center">
            <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-elev">
              <Sparkles size={20} className="text-fuchsia" />
            </div>
            <h2 className="mb-1 text-[15px] font-semibold">What should we build?</h2>
            <p className="text-[12.5px] leading-relaxed text-muted">
              Describe what you want in plain language. The agent plans, writes, runs and tests the code in this project
              folder, and you watch it happen live.
            </p>
            <p className="mt-3 text-[11px] text-muted">Ctrl+L focus input · Esc stop the agent · ↑ previous prompt</p>
          </div>
        )}
        {messages.map((m) => (
          <MessageView key={m.id} msg={m} />
        ))}
      </div>

      {!pinned && messages.length > 0 && (
        <button
          className="absolute bottom-36 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-[#2c2c38] bg-elev px-3 py-1 text-[11px] text-text2 shadow-lg hover:text-text"
          onClick={() => setPinned(true)}
        >
          <ArrowDown size={12} /> latest
        </button>
      )}

      <div className="shrink-0 px-3 pb-3">
        {running && (
          <div className="mb-2 rounded-xl border border-[#22222c] bg-panel p-2">
            <button
              className="flex w-full items-center gap-2 px-1 pb-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted"
              onClick={() => setInspectorOpen(!inspectorOpen)}
            >
              <Sparkles size={11} className="animate-pulse text-fuchsia" />
              live activity · {liveTools.length} tool call{liveTools.length === 1 ? "" : "s"}
              <span className="min-w-0 flex-1" />
              <ChevronRight size={11} className={`transition-transform ${inspectorOpen ? "rotate-90" : ""}`} />
            </button>
            {inspectorOpen && (
              <div className="max-h-36 space-y-0.5 overflow-y-auto">
                {liveTools.slice(-10).map((t) => (
                  <div key={t.id} className="flex items-center gap-2 px-1 text-[11.5px]">
                    <span className={t.isError ? "text-err" : t.result !== undefined ? "text-ok" : "text-fuchsia2"}>
                      {t.isError ? "✕" : t.result !== undefined ? "✓" : "◌"}
                    </span>
                    <span className="text-text2">{t.name}</span>
                    <span className="min-w-0 flex-1 truncate text-muted">{toolSummary(t)}</span>
                  </div>
                ))}
                {activityLog.slice(-3).map((l, i) => (
                  <div key={i} className="truncate px-1 font-mono text-[10.5px] text-muted" title={l}>
                    {l}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {(pendingElement || pendingSkill) && (
          <div className="mb-2 space-y-1">
            {pendingElement && (
              <div className="flex items-center gap-2 rounded-lg bg-select px-3 py-1.5 text-[12px]">
                <span className="text-fuchsia2">◎</span>
                <span className="min-w-0 flex-1 truncate text-text2">
                  {`<${pendingElement.tag}> ${pendingElement.text.slice(0, 60)} — included with next message`}
                </span>
                <button onClick={() => useApp.getState().setPendingElement(null)} className="text-muted hover:text-text">
                  <X size={13} />
                </button>
              </div>
            )}
            {pendingSkill && (
              <div className="flex items-center gap-2 rounded-lg bg-elev px-3 py-1.5 text-[12px]">
                <span className="text-fuchsia2">✦</span>
                <span className="min-w-0 flex-1 truncate text-text2">skill “{pendingSkill}” attached to next message</span>
                <button onClick={() => setPendingSkill(null)} className="text-muted hover:text-text">
                  <X size={13} />
                </button>
              </div>
            )}
          </div>
        )}

        <div className="rounded-2xl border border-[#2c2c38] bg-panel p-2 focus-within:border-fuchsia">
          <textarea
            ref={inputRef}
            className="max-h-[200px] w-full resize-none bg-transparent px-2 py-1.5 text-[13px] text-text outline-none placeholder:text-muted"
            rows={2}
            placeholder={
              project ? (running ? "Agent is working… (Esc to stop)" : "Describe what to build, change or fix…") : "Create or select a project first"
            }
            value={draft}
            disabled={!project}
            onChange={(e) => {
              setDraft(e.target.value);
              setHistoryIdx(-1);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              } else if (e.key === "ArrowUp" && (draft === "" || historyIdx >= 0) && history.length > 0) {
                e.preventDefault();
                const idx = Math.min(historyIdx + 1, history.length - 1);
                setHistoryIdx(idx);
                setDraft(history[idx]);
              } else if (e.key === "ArrowDown" && historyIdx >= 0) {
                e.preventDefault();
                const idx = historyIdx - 1;
                setHistoryIdx(idx);
                setDraft(idx >= 0 ? history[idx] : "");
              }
            }}
          />
          <div className="flex items-center gap-1 px-1">
            <span className="text-[10.5px] text-muted">Enter to send · Shift+Enter for newline</span>
            <span className="min-w-0 flex-1" />
            {running ? (
              <button className="btn btn-danger" onClick={stopRun} title="Stop the agent immediately (Esc)">
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
