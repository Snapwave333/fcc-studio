import { useEffect, useRef, useState } from "react";
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
  dataOff: () => void;
  exitOff: () => void;
}

let seq = 0;

export default function TerminalPane() {
  const project = useApp((s) => s.activeProject());
  const showToast = useApp((s) => s.showToast);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const tabsRef = useRef<TermTab[]>([]);
  const [tabs, setTabs] = useState<{ id: string; label: string }[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;

  const spawn = async (program: string, label: string) => {
    const cwd = project?.root;
    try {
      const { id } = await api.ptyCreate(program, cwd);
      const term = new Terminal({
        fontFamily: '"Cascadia Code", Consolas, monospace',
        fontSize: 12,
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
      const host = hostRef.current;
      if (host) {
        host.innerHTML = "";
        term.open(host);
        fit.fit();
      }
      const dataOff = await listenEvent<{ id: string; data: string }>("pty-out", ({ id: sid, data }) => {
        if (sid === id) term.write(data);
      });
      const exitOff = await listenEvent<{ id: string }>("pty-exit", ({ id: sid }) => {
        if (sid === id) term.writeln("\r\n\x1b[90m[process exited]\x1b[0m");
      });
      term.onData((data) => {
        api.ptyWrite(id, data).catch(() => {});
      });
      const tab: TermTab = { id, label: `${label} ${++seq}`, term, fit, dataOff, exitOff };
      tabsRef.current.push(tab);
      setTabs(tabsRef.current.map((t) => ({ id: t.id, label: t.label })));
      setActiveId(id);
      api.ptyResize(id, term.rows, term.cols).catch(() => {});
    } catch (e) {
      showToast(String(e));
    }
  };

  useEffect(() => {
    if (tabsRef.current.length === 0) {
      spawn("powershell.exe", "pwsh");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const tab = tabsRef.current.find((t) => t.id === activeId);
    if (tab && hostRef.current) {
      if (tab.term.element?.parentElement !== hostRef.current) {
        hostRef.current.innerHTML = "";
        hostRef.current.appendChild(tab.term.element!);
      }
      tab.fit.fit();
      tab.term.focus();
    }
  }, [activeId]);

  const closeTab = async (id: string) => {
    const tab = tabsRef.current.find((t) => t.id === id);
    if (!tab) return;
    tab.dataOff();
    tab.exitOff();
    tab.term.dispose();
    tabsRef.current = tabsRef.current.filter((t) => t.id !== id);
    await api.ptyKill(id).catch(() => {});
    setTabs(tabsRef.current.map((t) => ({ id: t.id, label: t.label })));
    setActiveId(tabsRef.current[0]?.id ?? null);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-[#22222c] px-2 py-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveId(t.id)}
            className={`flex items-center gap-1 rounded-t-md px-2.5 py-1 text-[11.5px] ${
              activeId === t.id ? "bg-elev text-text" : "text-muted hover:text-text2"
            }`}
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
        <button className="btn btn-ghost px-1.5" title="New PowerShell tab" onClick={() => spawn("powershell.exe", "pwsh")}>
          <Plus size={14} />
        </button>
        <button
          className="btn btn-ghost px-1.5 text-fuchsia2"
          title="Interactive fcc-claude session"
          onClick={() => spawn("fcc-claude", "fcc")}
        >
          fcc-claude
        </button>
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 p-1" />
    </div>
  );
}
