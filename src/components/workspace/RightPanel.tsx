import { lazy, Suspense, useState } from "react";
import { useApp } from "../../store/useApp";
import Preview from "./Preview";
import GitPane from "./GitPane";
import MemoryPane from "./MemoryPane";
import EnvPane from "./EnvPane";
import RedlinePane from "./RedlinePane";
import SkillsPane from "./SkillsPane";

const EditorPane = lazy(() => import("./EditorPane"));
const TerminalPane = lazy(() => import("./TerminalPane"));

const loading = (label: string) => (
  <div className="grid h-full place-items-center text-[12px] text-muted">Loading {label}…</div>
);

const TABS: [string, string][] = [
  ["preview", "Preview"],
  ["terminal", "Terminal"],
  ["git", "Git"],
  ["editor", "Editor"],
  ["skills", "Skills"],
  ["memory", "Memory"],
  ["redline", "Redline"],
  ["env", "Env"],
];

const KEEP_ALIVE = new Set(["preview", "terminal", "editor"]);

export default function RightPanel({ onToggle }: { width: number; onToggle: () => void }) {
  const tab = useApp((s) => s.layout.rightTab);
  const updateLayout = useApp((s) => s.updateLayout);
  const project = useApp((s) => s.activeProject());
  const [visited, setVisited] = useState<Set<string>>(() => new Set([tab]));

  const select = (id: string) => {
    setVisited((v) => (v.has(id) ? v : new Set(v).add(id)));
    updateLayout({ rightTab: id });
  };

  if (!visited.has(tab)) setVisited((v) => new Set(v).add(tab));

  const pane = (id: string) => {
    switch (id) {
      case "preview":
        return <Preview />;
      case "terminal":
        return (
          <Suspense fallback={loading("terminal")}>
            <TerminalPane active={tab === "terminal"} />
          </Suspense>
        );
      case "git":
        return <GitPane />;
      case "memory":
        return <MemoryPane />;
      case "redline":
        return <RedlinePane />;
      case "skills":
        return <SkillsPane />;
      case "env":
        return <EnvPane />;
      case "editor":
        return (
          <Suspense fallback={loading("editor")}>
            <EditorPane active={tab === "editor"} />
          </Suspense>
        );
      default:
        return null;
    }
  };

  return (
    <div className="flex h-full flex-col border-l border-[#22222c] bg-panel">
      <div className="flex items-center gap-0.5 overflow-x-auto border-b border-[#22222c] px-1.5 py-1.5">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            className={`shrink-0 rounded-md px-2.5 py-1 text-[11.5px] transition-colors ${
              tab === id ? "bg-elev text-text" : "text-muted hover:text-text2"
            }`}
            onClick={() => select(id)}
          >
            {label}
          </button>
        ))}
        <span className="min-w-0 flex-1" />
        <button className="btn btn-ghost px-1.5 text-muted hover:text-text" onClick={onToggle} title="Hide panel (Ctrl+J)">
          ✕
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        {TABS.map(([id]) => {
          const keep = KEEP_ALIVE.has(id) && visited.has(id);
          if (id !== tab && !keep) return null;
          return (
            <div key={id} className="absolute inset-0 overflow-hidden" style={{ display: id === tab ? "block" : "none" }}>
              {pane(id)}
            </div>
          );
        })}
      </div>
      {project && tab === "preview" && (
        <div className="truncate border-t border-[#22222c] px-3 py-1 text-[10.5px] text-muted" title={project.root}>
          {project.root}
        </div>
      )}
    </div>
  );
}
