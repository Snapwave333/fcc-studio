import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Brain, Eye, FileCode, Gauge, GitBranch, PanelRightClose, Settings2, SquareTerminal, Wrench } from "lucide-react";
import { RightTab, useApp } from "../../store/useApp";
import Preview from "./Preview";

const TerminalPane = lazy(() => import("./TerminalPane"));
const GitPane = lazy(() => import("./GitPane"));
const EditorPane = lazy(() => import("./EditorPane"));
const SkillsPane = lazy(() => import("./SkillsPane"));
const MemoryPane = lazy(() => import("./MemoryPane"));
const RedlinePane = lazy(() => import("./RedlinePane"));
const EnvPane = lazy(() => import("./EnvPane"));

const TABS: [RightTab, string, typeof Eye][] = [
  ["preview", "Preview", Eye],
  ["terminal", "Terminal", SquareTerminal],
  ["git", "Git", GitBranch],
  ["editor", "Editor", FileCode],
  ["skills", "Skills", Wrench],
  ["memory", "Memory", Brain],
  ["redline", "Redline", Gauge],
  ["env", "Env", Settings2],
];

function Pane({ tab }: { tab: RightTab }) {
  switch (tab) {
    case "preview":
      return <Preview />;
    case "terminal":
      return <TerminalPane />;
    case "git":
      return <GitPane />;
    case "editor":
      return <EditorPane />;
    case "skills":
      return <SkillsPane />;
    case "memory":
      return <MemoryPane />;
    case "redline":
      return <RedlinePane />;
    case "env":
      return <EnvPane />;
  }
}

export default function RightPanel({ onToggle }: { onToggle: () => void }) {
  const tab = useApp((s) => s.rightTab);
  const setTab = useApp((s) => s.setRightTab);
  const activeFile = useApp((s) => s.activeFile);
  const [mounted, setMounted] = useState<RightTab[]>([tab]);
  const [compact, setCompact] = useState(false);
  const stripRef = useRef<HTMLDivElement>(null);
  const fullWidth = useRef(0);

  useLayoutEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const check = () => {
      if (!compact && el.scrollWidth > el.clientWidth + 1) {
        fullWidth.current = el.scrollWidth;
        setCompact(true);
      } else if (compact && fullWidth.current && el.clientWidth >= fullWidth.current) {
        setCompact(false);
      }
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [compact]);

  useEffect(() => {
    setMounted((m) => (m.includes(tab) ? m : [...m, tab]));
  }, [tab]);

  return (
    <div className="flex h-full flex-col border-l border-[#22222c] bg-panel">
      <div ref={stripRef} role="tablist" className="flex items-center gap-0.5 overflow-hidden border-b border-[#22222c] px-1.5 py-1.5">
        {TABS.map(([id, label, Icon]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            title={compact ? label : undefined}
            className={`relative flex shrink-0 items-center rounded-md py-1 text-[11.5px] transition-colors ${compact ? "px-2" : "px-2.5"} ${
              tab === id ? "bg-elev text-text" : "text-muted hover:text-text2"
            }`}
            onClick={() => setTab(id)}
          >
            {compact ? (
              <>
                <Icon size={14} aria-hidden="true" />
                <span className="sr-only">{label}</span>
              </>
            ) : (
              label
            )}
            {id === "editor" && activeFile && (
              <span className={compact ? "absolute right-0.5 top-0 text-[10px] text-fuchsia2" : "ml-1 text-fuchsia2"}>•</span>
            )}
          </button>
        ))}
        <span className="min-w-0 flex-1" />
        <button className="btn btn-ghost shrink-0 px-1.5 text-muted hover:text-text" onClick={onToggle} title="Hide panel">
          <PanelRightClose size={14} />
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        {mounted.map((id) => (
          <div key={id} role="tabpanel" className={`absolute inset-0 ${tab === id ? "" : "invisible pointer-events-none"}`}>
            <Suspense fallback={<div className="p-4 text-[12px] text-muted">Loading…</div>}>
              <Pane tab={id} />
            </Suspense>
          </div>
        ))}
      </div>
    </div>
  );
}
