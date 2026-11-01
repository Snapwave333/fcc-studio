import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ChevronRight,
  CircleStop,
  Copy,
  History,
  Pencil,
  RotateCcw,
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
import { Markdown } from "../../lib/markdown";
import { relativeTime } from "../../lib/format";
import { rankFiles } from "../common/QuickOpen";
import { api } from "../../lib/api";

export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = before.match(/(^|\s)@([^\s@]*)$/);
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

export function toolSummary(tool: ToolActivity): string {
  const i = tool.input ?? {};
  const v = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt ?? Object.values(i)[0] ?? "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

function ToolBlock({ tool, live }: { tool: ToolActivity; live: boolean }) {
  const [open, setOpen] = useState(false);
  const icon = /bash/i.test(tool.name) ? <TerminalIcon size={12} /> : <Wrench size={12} />;
  const status = tool.result !== undefined ? (tool.isError ? "failed" : "done") : live ? "running…" : "no result";
  return (
    <div className="rounded-lg border border-[#26262f] bg-bg2 text-[11.5px]">
      <button className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left" onClick={() => setOpen((v) => !v)}>
        <span className={tool.isError ? "text-err" : "text-fuchsia2"}>{tool.isError ? <AlertTriangle size={12} /> : icon}</span>
        <span className="font-medium text-text2">{tool.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">{toolSummary(tool).slice(0, 160)}</span>
        <span className={tool.isError ? "text-err" : tool.result !== undefined ? "text-ok" : "text-muted"}>
          {status === "running…" ? <span className="animate-pulse">{status}</span> : status}
        </span>
        <ChevronRight size={12} className={`text-muted transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="border-t border-[#26262f] px-2.5 py-1.5">
          <div className="mb-1 text-[10.5px] uppercase tracking-wide text-muted">input</div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-text2">{JSON.stringify(tool.input, null, 2)}</pre>
          {tool.result !== undefined && (
            <>
              <div className="mb-1 mt-2 text-[10.5px] uppercase tracking-wide text-muted">result</div>
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-muted">{tool.result || "(empty)"}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const MessageView = memo(function MessageView({
  msg,
  onEdit,
  onRetry,
}: {
  msg: ChatMessage;
  onEdit?: (text: string) => void;
  onRetry?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (msg.role === "user") {
    return (
      <div className="group flex flex-col items-end gap-0.5">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-select px-3.5 py-2 text-[13px] leading-relaxed">
          {msg.text}
        </div>
        <div className="flex items-center gap-2 pr-1 text-[10.5px] text-muted">
          {msg.meta && <span>{msg.meta}</span>}
          {onEdit && (
            <button className="invisible flex items-center gap-1 hover:text-text group-hover:visible" onClick={() => onEdit(msg.text)} title="Edit and resend">
              <Pencil size={10} /> edit
            </button>
          )}
        </div>
      </div>
    );
  }
  const toolById = new Map(msg.tools.map((t) => [t.id, t]));
  const parts = msg.parts?.length
    ? msg.parts
    : [...msg.tools.map((t) => ({ kind: "tool" as const, id: t.id })), ...(msg.text ? [{ kind: "text" as const, text: msg.text }] : [])];
  const errorText = msg.error && !msg.parts?.some((p) => p.kind === "text") ? msg.text : "";
  return (
    <div className="group space-y-1.5">
      {parts.map((p, i) => {
        if (p.kind === "tool") {
          const tool = toolById.get(p.id);
          return tool ? <ToolBlock key={`t-${p.id}`} tool={tool} live={msg.streaming} /> : null;
        }
        return (
          <div key={`x-${i}`} className={msg.error ? "rounded-lg border border-err/30 bg-err/5 px-3 py-2" : ""}>
            <Markdown text={p.text} />
          </div>
        );
      })}
      {errorText && !parts.some((p) => p.kind === "text") && (
        <div className="rounded-lg border border-err/30 bg-err/5 px-3 py-2">
          <Markdown text={errorText} />
        </div>
      )}
      {msg.streaming && (msg.thinking || (!msg.text && msg.tools.length === 0)) && (
        <div className="flex items-center gap-2 text-[12px] text-muted">
          <Sparkles size={13} className="animate-pulse text-fuchsia" />
          thinking…
        </div>
      )}
      {!msg.streaming && (msg.meta || msg.text) && (
        <div className="flex items-center gap-2 text-[10.5px] text-muted">
          {msg.meta && <span>{msg.meta}</span>}
          {onRetry && (
            <button className="flex items-center gap-1 text-fuchsia2 hover:text-text" onClick={onRetry} title="Send the previous prompt again">
              <RotateCcw size={10} /> retry
            </button>
          )}
          {msg.text && (
            <button
              className="invisible flex items-center gap-1 hover:text-text group-hover:visible"
              onClick={() => {
                navigator.clipboard?.writeText(msg.text).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                });
              }}
            >
              <Copy size={10} /> {copied ? "copied" : "copy"}
            </button>
          )}
        </div>
      )}
    </div>
  );
});

function ThreadMenu({ onClose }: { onClose: () => void }) {
  const threads = useApp((s) => s.threads);
  const threadId = useApp((s) => s.threadId);
  const openThread = useApp((s) => s.openThread);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose]);
  return (
    <div ref={ref} className="absolute right-2 top-10 z-40 max-h-80 w-80 overflow-y-auto rounded-xl border border-[#2c2c38] bg-elev p-1.5 shadow-2xl">
      <div className="px-2 pb-1 text-[10.5px] uppercase tracking-wider text-muted">conversations</div>
      {threads.length === 0 && <div className="px-2 py-1.5 text-[12px] text-muted">No saved conversations yet.</div>}
      {threads.map((t) => (
        <button
          key={t.id}
          className={`block w-full rounded-lg px-2 py-1.5 text-left hover:bg-panel ${t.id === threadId ? "bg-panel" : ""}`}
          onClick={() => {
            openThread(t.id);
            onClose();
          }}
        >
          <div className="truncate text-[12px] text-text2">{t.title}</div>
          <div className="text-[10.5px] text-muted">
            {t.count} messages · {relativeTime(new Date(t.updated).toISOString())}
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
  const threads = useApp((s) => s.threads);
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sentHistory = useRef<string[]>([]);
  const historyIdx = useRef(-1);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [projectFiles, setProjectFiles] = useState<string[] | null>(null);
  const mentionResults = mention && projectFiles ? rankFiles(mention.query, projectFiles, 8) : [];

  useEffect(() => {
    setProjectFiles(null);
    setMention(null);
  }, [project?.id]);

  useEffect(() => {
    if (!mention || projectFiles || !project) return;
    api
      .listFiles(project.root)
      .then(setProjectFiles)
      .catch(() => setProjectFiles([]));
  }, [mention, projectFiles, project?.root]);

  useEffect(() => setMentionIdx(0), [mention?.query]);

  const updateMention = (value: string, caret: number) => setMention(mentionAt(value, caret));

  const insertMention = (rel: string) => {
    if (!mention) return;
    const el = inputRef.current;
    const caret = el?.selectionStart ?? draft.length;
    const token = /\s/.test(rel) ? `@"${rel}"` : `@${rel}`;
    const next = draft.slice(0, mention.start) + token + " " + draft.slice(caret);
    const pos = mention.start + token.length + 1;
    setDraft(next);
    setMention(null);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  }, [messages, atBottom]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(220, el.scrollHeight)}px`;
  }, [draft]);

  useEffect(() => {
    if (!running) inputRef.current?.focus();
  }, [running, project?.id]);

  const submit = () => {
    if (!draft.trim() || running || !project) return;
    const text = draft;
    sentHistory.current = [text, ...sentHistory.current.filter((h) => h !== text)].slice(0, 50);
    historyIdx.current = -1;
    setDraft("");
    setAtBottom(true);
    sendMessage(text);
  };

  const editMessage = useCallback((text: string) => {
    setDraft(text);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      el?.focus();
      el?.setSelectionRange(text.length, text.length);
    });
  }, []);

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const lastMsg = messages[messages.length - 1];
  const canRetry = !running && !!lastUser && lastMsg?.role === "assistant" && (lastMsg.error || lastMsg.meta === "stopped by user");
  const retry = useCallback(() => {
    const st = useApp.getState();
    const u = [...st.messages].reverse().find((m) => m.role === "user");
    if (u && !st.running) st.sendMessage(u.text);
  }, []);

  const liveTools: ToolActivity[] = running ? messages[messages.length - 1]?.tools ?? [] : [];

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
          <span className="chip font-mono" title={`Claude session ${sessionId}`}>
            {sessionId.slice(0, 8)}
          </span>
        )}
        <span className="min-w-0 flex-1" />
        {project && (
          <button className="btn btn-ghost px-1.5" onClick={() => setHistoryOpen((v) => !v)} title="Conversation history">
            <History size={14} />
            {threads.length > 0 && <span className="text-[11px] text-muted">{threads.length}</span>}
          </button>
        )}
        {messages.length > 0 && (
          <button className="btn btn-ghost" onClick={newSession} disabled={running} title="Start a fresh conversation (Ctrl/⌘+Shift+N)">
            <Plus size={13} /> New
          </button>
        )}
        {!rightOpen && (
          <button className="btn btn-ghost px-1.5" onClick={onToggleRight} title="Show right panel">
            <PanelRight size={15} />
          </button>
        )}
      </div>
      {historyOpen && <ThreadMenu onClose={() => setHistoryOpen(false)} />}

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4"
        onScroll={(e) => {
          const el = e.currentTarget;
          setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
        }}
      >
        {messages.length === 0 && (
          <div className="mx-auto mt-24 max-w-md text-center">
            <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-elev">
              <Sparkles size={20} className="text-fuchsia" />
            </div>
            <h2 className="mb-1 text-[15px] font-semibold">{project ? "What should we build?" : "Open a project folder to start"}</h2>
            <p className="text-[12.5px] leading-relaxed text-muted">
              {project
                ? "Describe what you want in plain language. The agent plans, writes, runs and tests the code in this project folder, and you watch it happen live."
                : "Use the + button in the left panel to pick a folder. Serenity remembers projects, conversations and layout between launches."}
            </p>
          </div>
        )}
        {messages.map((m) => (
          <MessageView
            key={m.id}
            msg={m}
            onEdit={m.role === "user" && !running ? editMessage : undefined}
            onRetry={canRetry && m.id === lastMsg?.id ? retry : undefined}
          />
        ))}
      </div>

      {!atBottom && messages.length > 0 && (
        <button
          className="absolute bottom-36 left-1/2 z-10 -translate-x-1/2 rounded-full border border-[#2c2c38] bg-elev p-1.5 text-text2 shadow-lg hover:text-text"
          onClick={() => setAtBottom(true)}
          title="Jump to latest"
        >
          <ArrowDown size={14} />
        </button>
      )}

      <div className="shrink-0 px-3 pb-3">
        {running && inspectorOpen && (liveTools.length > 0 || activityLog.length > 0) && (
          <div className="mb-2 max-h-40 space-y-1 overflow-y-auto rounded-xl border border-[#22222c] bg-panel p-2">
            <div className="flex items-center px-1 pb-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted">
              <span className="flex-1">live activity · {liveTools.length} tool calls</span>
              <button className="normal-case hover:text-text" onClick={() => setInspectorOpen(false)}>
                hide
              </button>
            </div>
            {liveTools.slice(-12).map((t) => (
              <div key={t.id} className="flex items-center gap-2 px-1 text-[11.5px]">
                <span className={t.isError ? "text-err" : t.result !== undefined ? "text-ok" : "animate-pulse text-fuchsia2"}>
                  {t.isError ? "✕" : t.result !== undefined ? "✓" : "◌"}
                </span>
                <span className="text-text2">{t.name}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">{toolSummary(t)}</span>
              </div>
            ))}
            {activityLog.slice(-3).map((l, i) => (
              <div key={i} className="truncate px-1 font-mono text-[10.5px] text-muted" title={l}>
                {l}
              </div>
            ))}
          </div>
        )}
        {running && !inspectorOpen && (
          <button className="mb-1 px-1 text-[10.5px] text-muted hover:text-text" onClick={() => setInspectorOpen(true)}>
            show live activity
          </button>
        )}

        {(pendingElement || pendingSkill) && (
          <div className="mb-2 space-y-1">
            {pendingElement && (
              <div className="flex items-center gap-2 rounded-lg bg-select px-3 py-1.5 text-[12px]">
                <span className="text-fuchsia2">◎</span>
                <span className="min-w-0 flex-1 truncate text-text2">
                  {`<${pendingElement.tag}> ${pendingElement.text.slice(0, 60)} — included with next message`}
                </span>
                <button onClick={() => useApp.getState().setPendingElement(null)} className="text-muted hover:text-text" title="Remove">
                  <X size={13} />
                </button>
              </div>
            )}
            {pendingSkill && (
              <div className="flex items-center gap-2 rounded-lg bg-elev px-3 py-1.5 text-[12px]">
                <Wrench size={12} className="text-fuchsia2" />
                <span className="min-w-0 flex-1 truncate text-text2">skill “{pendingSkill}” attached to next message</span>
                <button onClick={() => setPendingSkill(null)} className="text-muted hover:text-text" title="Remove">
                  <X size={13} />
                </button>
              </div>
            )}
          </div>
        )}

        <div className="relative rounded-2xl border border-[#2c2c38] bg-panel p-2 focus-within:border-fuchsia">
          {mention && (
            <div role="listbox" aria-label="File mentions" className="absolute bottom-full left-2 right-2 mb-1.5 max-h-64 overflow-y-auto rounded-xl border border-[#2c2c38] bg-elev p-1 shadow-2xl">
              {!projectFiles && <div className="px-2.5 py-1.5 text-[11.5px] text-muted">indexing files…</div>}
              {projectFiles && mentionResults.length === 0 && <div className="px-2.5 py-1.5 text-[11.5px] text-muted">No matching files</div>}
              {mentionResults.map((f, i) => (
                <button
                  key={f}
                  role="option"
                  aria-selected={i === mentionIdx}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1 text-left text-[12px] ${i === mentionIdx ? "bg-select text-text" : "text-text2 hover:bg-panel"}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    insertMention(f);
                  }}
                >
                  <span className="text-fuchsia2">@</span>
                  <span className="truncate">{f}</span>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            className="w-full resize-none bg-transparent px-2 py-1.5 text-[13px] text-text outline-none placeholder:text-muted"
            rows={2}
            placeholder={project ? (running ? "Agent is working… (Esc to stop)" : "Describe what to build, change or fix…") : "Create or select a project first"}
            value={draft}
            disabled={!project}
            onChange={(e) => {
              setDraft(e.target.value);
              historyIdx.current = -1;
              updateMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
            }}
            onClick={(e) => updateMention(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
            onBlur={() => setTimeout(() => setMention(null), 120)}
            onKeyDown={(e) => {
              if (mention && mentionResults.length > 0) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const d = e.key === "ArrowDown" ? 1 : -1;
                  setMentionIdx((i) => (i + d + mentionResults.length) % mentionResults.length);
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  insertMention(mentionResults[mentionIdx]);
                  return;
                }
              }
              if (mention && e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setMention(null);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              } else if (e.key === "ArrowUp" && !draft.trim() && sentHistory.current.length) {
                e.preventDefault();
                historyIdx.current = Math.min(sentHistory.current.length - 1, historyIdx.current + 1);
                setDraft(sentHistory.current[historyIdx.current]);
              }
            }}
          />
          <div className="flex items-center gap-1 px-1">
            <span className="text-[10.5px] text-muted">Enter to send · Shift+Enter newline · @ file · ↑ recall</span>
            <span className="min-w-0 flex-1" />
            {running ? (
              <button className="btn btn-danger" onClick={stopRun} title="Stop the agent (Esc)">
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
