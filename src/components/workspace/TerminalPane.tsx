import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Bot, Plus, X } from "lucide-react";
import { api, listenEvent } from "../../lib/api";
import { useApp } from "../../store/useApp";

interface TermTab {
  id: string;
  label: string;
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  exited: boolean;
  off: (() => void)[];
}

let seq = 0;

function shellLabel(program: string): string {
  const base = program.split(/[\\/]/).pop()?.replace(/\.exe$/i, "") ?? program;
  return base === "powershell" ? "pwsh" : base;
}

export default function TerminalPane() {
  const showToast = useApp((s) => s.showToast);
  const visible = useApp((s) => s.rightTab === "terminal");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tabsRef = useRef<TermTab[]>([]);
  const [tabs, setTabs] = useState<{ id: string; label: string; exited: boolean }[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const spawning = useRef(false);

  const sync = () => setTabs(tabsRef.current.map((t) => ({ id: t.id, label: t.label, exited: t.exited })));

  const fitActive = () => {
    const tab = tabsRef.current.find((t) => t.id === activeIdRef.current);
    if (!tab || !tab.host.offsetWidth) return;
    try {
      tab.fit.fit();
      api.ptyResize(tab.id, tab.term.rows, tab.term.cols).catch(() => {});
    } catch {
      return;
    }
  };
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  const spawn = async (program: string) => {
    if (spawning.current || !containerRef.current) return;
    spawning.current = true;
    const st = useApp.getState();
    const cwd = st.activeProject()?.root;
    const host = document.createElement("div");
    host.className = "absolute inset-0 p-1";
    host.style.visibility = "hidden";
    containerRef.current.appendChild(host);
    const term = new Terminal({
      fontFamily: '"Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace',
      fontSize: 12,
      scrollback: 5000,
      allowProposedApi: true,
      theme: {
        background: "#101014",
        foreground: "#f4f1f7",
        cursor: "#f000b8",
        selectionBackground: "#512044",
      },
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      fit.fit();
    } catch {
      host.style.visibility = "hidden";
    }
    let myId: string | null = null;
    const early: { id: string; data: string }[] = [];
    let earlyExit: { id: string; code: number | null } | null = null;
    let onExit: (code: number | null) => void = () => {};
    const offOut = await listenEvent<{ id: string; data: string }>("pty-out", (p) => {
      if (myId === null) early.push(p);
      else if (p.id === myId) term.write(p.data);
    });
    const offExit = await listenEvent<{ id: string; code: number | null }>("pty-exit", (p) => {
      if (myId === null) earlyExit = p;
      else if (p.id === myId) onExit(p.code);
    });
    try {
      const { id, program: resolved } = await api.ptyCreate(program, cwd, st.autonomy, term.rows, term.cols);
      myId = id;
      for (const p of early) if (p.id === id) term.write(p.data);
      const tab: TermTab = {
        id,
        label: `${program === "fcc-claude" ? "fcc" : shellLabel(resolved)} ${++seq}`,
        term,
        fit,
        host,
        exited: false,
        off: [offOut, offExit],
      };
      onExit = (code) => {
        tab.exited = true;
        term.writeln(`\r\n\x1b[90m[process exited${code != null ? ` with code ${code}` : ""}]\x1b[0m`);
        sync();
      };
      const ex = earlyExit as { id: string; code: number | null } | null;
      if (ex && ex.id === id) onExit(ex.code);
      const dataSub = term.onData((data) => {
        if (!tab.exited) api.ptyWrite(id, data).catch(() => {});
      });
      tab.off.push(() => dataSub.dispose());
      tabsRef.current.push(tab);
      sync();
      setActiveId(id);
    } catch (e) {
      offOut();
      offExit();
      term.dispose();
      host.remove();
      showToast(String(e));
    } finally {
      spawning.current = false;
    }
  };

  useEffect(() => {
    if (tabsRef.current.length === 0) spawn("shell");
    return () => {
      for (const t of tabsRef.current) {
        t.off.forEach((f) => f());
        t.term.dispose();
        api.ptyKill(t.id).catch(() => {});
      }
      tabsRef.current = [];
    };
  }, []);

  useEffect(() => {
    for (const t of tabsRef.current) t.host.style.visibility = t.id === activeId ? "inherit" : "hidden";
    const tab = tabsRef.current.find((t) => t.id === activeId);
    if (tab) {
      requestAnimationFrame(() => {
        fitActive();
        if (visible) tab.term.focus();
      });
    }
  }, [activeId, visible]);

  useEffect(() => {
    if (!containerRef.current) return;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fitActive);
    });
    ro.observe(containerRef.current);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, []);

  const closeTab = async (id: string) => {
    const tab = tabsRef.current.find((t) => t.id === id);
    if (!tab) return;
    tab.off.forEach((f) => f());
    tab.term.dispose();
    tab.host.remove();
    tabsRef.current = tabsRef.current.filter((t) => t.id !== id);
    await api.ptyKill(id).catch(() => {});
    sync();
    if (activeIdRef.current === id) setActiveId(tabsRef.current[tabsRef.current.length - 1]?.id ?? null);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 overflow-x-auto border-b border-[#22222c] px-2 py-1">
        {tabs.map((t) => (
          <div
            key={t.id}
            role="button"
            tabIndex={0}
            onClick={() => setActiveId(t.id)}
            onAuxClick={(e) => {
              if (e.button === 1) closeTab(t.id);
            }}
            className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] ${
              activeId === t.id ? "bg-elev text-text" : "text-muted hover:text-text2"
            } ${t.exited ? "line-through opacity-60" : ""}`}
          >
            {t.label}
            <button
              className="hover:text-err"
              title="Close terminal"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.id);
              }}
            >
              <X size={11} />
            </button>
          </div>
        ))}
        <button className="btn btn-ghost shrink-0 px-1.5" title="New shell" onClick={() => spawn("shell")}>
          <Plus size={14} />
        </button>
        <button
          className="btn btn-ghost shrink-0 px-1.5 text-fuchsia2"
          title="Interactive fcc-claude session (uses the current autonomy mode)"
          onClick={() => spawn("fcc-claude")}
        >
          <Bot size={13} /> fcc-claude
        </button>
      </div>
      <div ref={containerRef} className="relative min-h-0 flex-1">
        {tabs.length === 0 && (
          <div className="grid h-full place-items-center text-[12px] text-muted">
            <button className="btn btn-ghost" onClick={() => spawn("shell")}>
              <Plus size={13} /> Open a terminal
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
