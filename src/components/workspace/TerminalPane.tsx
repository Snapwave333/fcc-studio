import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Plus, X } from "lucide-react";
import { api, listenEvent } from "../../lib/api";
import { useApp } from "../../store/useApp";

interface TermTab {
  id: string;
  label: string;
  term: Terminal;
  fit: FitAddon;
  element: HTMLDivElement;
  exited: boolean;
}

let seq = 0;
const unclaimed = new Map<string, string[]>();

function shellLabel(program: string): string {
  const name = program.split(/[\\/]/).pop()?.replace(/\.exe$/i, "") ?? program;
  return name === "powershell" ? "pwsh" : name;
}

export default function TerminalPane({ active }: { active: boolean }) {
  const project = useApp((s) => s.activeProject());
  const showToast = useApp((s) => s.showToast);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const tabsRef = useRef<TermTab[]>([]);
  const [tabs, setTabs] = useState<{ id: string; label: string; exited: boolean }[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const spawning = useRef(false);

  const sync = () => setTabs(tabsRef.current.map((t) => ({ id: t.id, label: t.label, exited: t.exited })));

  const fitActive = useCallback(() => {
    const tab = tabsRef.current.find((t) => t.id === activeId);
    if (!tab || !hostRef.current || hostRef.current.clientWidth === 0) return;
    try {
      tab.fit.fit();
      if (!tab.exited) api.ptyResize(tab.id, tab.term.rows, tab.term.cols).catch(() => {});
    } catch {
      return;
    }
  }, [activeId]);

  const spawn = useCallback(
    async (program: string | null) => {
      if (spawning.current || !hostRef.current) return;
      spawning.current = true;
      const element = document.createElement("div");
      element.style.height = "100%";
      element.style.width = "100%";
      const term = new Terminal({
        fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
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
      hostRef.current.replaceChildren(element);
      term.open(element);
      try {
        fit.fit();
      } catch {
        term.resize(120, 30);
      }
      try {
        const res = await api.ptyCreate(program, project?.root, term.rows, term.cols);
        const tab: TermTab = { id: res.id, label: `${shellLabel(res.program)} ${++seq}`, term, fit, element, exited: false };
        term.onData((data) => {
          if (!tab.exited) api.ptyWrite(res.id, data).catch(() => {});
        });
        tabsRef.current.push(tab);
        for (const chunk of unclaimed.get(res.id) ?? []) term.write(chunk);
        unclaimed.delete(res.id);
        sync();
        setActiveId(res.id);
      } catch (e) {
        term.dispose();
        element.remove();
        showToast(String(e));
        const current = tabsRef.current.find((t) => t.id === activeId);
        if (current && hostRef.current) hostRef.current.replaceChildren(current.element);
      } finally {
        spawning.current = false;
      }
    },
    [project?.root, showToast, activeId]
  );

  useEffect(() => {
    let disposed = false;
    const offs: (() => void)[] = [];
    listenEvent<{ id: string; data: string }>("pty-out", ({ id, data }) => {
      const tab = tabsRef.current.find((t) => t.id === id);
      if (tab) tab.term.write(data);
      else if (unclaimed.size < 32) unclaimed.set(id, [...(unclaimed.get(id) ?? []), data].slice(-200));
    }).then((f) => (disposed ? f() : offs.push(f)));
    listenEvent<{ id: string; code: number | null }>("pty-exit", ({ id, code }) => {
      const tab = tabsRef.current.find((t) => t.id === id);
      if (!tab) return;
      tab.exited = true;
      tab.term.writeln(`\r\n\x1b[90m[process exited${code !== null && code !== undefined ? ` with code ${code}` : ""}]\x1b[0m`);
      sync();
    }).then((f) => (disposed ? f() : offs.push(f)));
    return () => {
      disposed = true;
      offs.forEach((f) => f());
      for (const t of tabsRef.current) {
        api.ptyKill(t.id).catch(() => {});
        t.term.dispose();
      }
      tabsRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (active && tabsRef.current.length === 0) spawn(null);
  }, [active]);

  useEffect(() => {
    const tab = tabsRef.current.find((t) => t.id === activeId);
    if (!tab || !hostRef.current) return;
    if (tab.element.parentElement !== hostRef.current) hostRef.current.replaceChildren(tab.element);
    requestAnimationFrame(() => {
      fitActive();
      if (active) tab.term.focus();
    });
  }, [activeId, active, fitActive]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fitActive);
    });
    ro.observe(host);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [fitActive]);

  const closeTab = async (id: string) => {
    const tab = tabsRef.current.find((t) => t.id === id);
    if (!tab) return;
    tab.term.dispose();
    tab.element.remove();
    tabsRef.current = tabsRef.current.filter((t) => t.id !== id);
    await api.ptyKill(id).catch(() => {});
    sync();
    const next = tabsRef.current.at(-1);
    setActiveId(next?.id ?? null);
    if (!next && hostRef.current) hostRef.current.replaceChildren();
  };

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex items-center gap-1 overflow-x-auto border-b border-[#22222c] px-2 py-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveId(t.id)}
            className={`flex shrink-0 items-center gap-1 rounded-t-md px-2.5 py-1 text-[11.5px] ${
              activeId === t.id ? "bg-elev text-text" : "text-muted hover:text-text2"
            } ${t.exited ? "line-through opacity-60" : ""}`}
          >
            {t.label}
            <X
              size={11}
              className="hover:text-err"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.id);
              }}
            />
          </button>
        ))}
        <button className="btn btn-ghost px-1.5" title="New shell tab" onClick={() => spawn(null)}>
          <Plus size={14} />
        </button>
        <button className="btn btn-ghost shrink-0 px-1.5 text-fuchsia2" title="Interactive fcc-claude session" onClick={() => spawn("fcc-claude")}>
          fcc-claude
        </button>
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 bg-[#101014] p-1" />
      {tabs.length === 0 && (
        <div className="absolute inset-x-0 top-1/2 text-center text-[12px] text-muted">
          <button className="btn btn-primary" onClick={() => spawn(null)}>
            Open a terminal
          </button>
        </div>
      )}
    </div>
  );
}
