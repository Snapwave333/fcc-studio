import { lazy, Suspense, useEffect, useState } from "react";
import { PanelRightClose } from "lucide-react";
import { RightTab, useApp } from "../../store/useApp";
import Preview from "./Preview";

const TerminalPane = lazy(() => import("./TerminalPane"));
const GitPane = lazy(() => import("./GitPane"));
const EditorPane = lazy(() => import("./EditorPane"));
const SkillsPane = lazy(() => import("./SkillsPane"));
const MemoryPane = lazy(() => import("./MemoryPane"));
const RedlinePane = lazy(() => import("./RedlinePane"));
const EnvPane = lazy(() => import("./EnvPane"));

const TABS: [RightTab, string][] = [
  ["preview", "Preview"],
  ["terminal", "Terminal"],
  ["git", "Git"],
  ["editor", "Editor"],
  ["skills", "Skills"],
  ["memory", "Memory"],
  ["redline", "Redline"],
  ["env", "Env"],
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

  useEffect(() => {
    setMounted((m) => (m.includes(tab) ? m : [...m, tab]));
  }, [tab]);

  return (
    <div className="flex h-full flex-col border-l border-[#22222c] bg-panel">
      <div role="tablist" className="flex items-center gap-0.5 overflow-x-auto border-b border-[#22222c] px-1.5 py-1.5">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={`shrink-0 rounded-md px-2.5 py-1 text-[11.5px] transition-colors ${
              tab === id ? "bg-elev text-text" : "text-muted hover:text-text2"
            }`}
            onClick={() => setTab(id)}
          >
            {label}
            {id === "editor" && activeFile && <span className="ml-1 text-fuchsia2">•</span>}
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
