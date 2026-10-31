import { useEffect, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { useApp } from "../../store/useApp";
import { api } from "../../lib/api";

export default function RightPanel({ width, onToggle }: { width: number; onToggle: () => void }) {
  const [tab, setTab] = useState("preview");
  const project = useApp((s) => s.activeProject());
  const activeFile = useApp((s) => s.activeFile);
  const openFile = useApp((s) => s.openFile);
  const bumpTree = useApp((s) => s.bumpTree);
  const showToast = useApp((s) => s.showToast);
  const [fileContent, setFileContent] = useState("");

  useEffect(() => {
    if (activeFile) {
      api
        .readFile(activeFile)
        .then(setFileContent)
        .catch((e) => {
          showToast(String(e));
          openFile(null);
        });
    }
  }, [activeFile]);

  const tabs = [
    ["preview", "Preview"],
    ["terminal", "Terminal"],
    ["git", "Git"],
    ["editor", "Editor"],
    ["skills", "Skills"],
    ["memory", "Memory"],
    ["redline", "Redline"],
    ["env", "Env"],
  ];

  return (
    <div className="flex h-full flex-col border-l border-[#22222c] bg-panel">
      <div className="flex items-center gap-0.5 border-b border-[#22222c] px-1.5 py-1.5">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            className={`rounded-md px-2.5 py-1 text-[11.5px] transition-colors ${
              tab === id ? "bg-elev text-text" : "text-muted hover:text-text2"
            }`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
        <span className="min-w-0 flex-1" />
        <button className="btn btn-ghost px-1.5 text-muted hover:text-text" onClick={onToggle} title="Hide panel">
          ✕
        </button>
      </div>

      <div className="min-h-0 flex-1">
        {tab === "preview" && <Preview />}
        {tab === "terminal" && <TerminalPane />}
        {tab === "git" && <GitPane />}
        {tab === "memory" && <MemoryPane />}
        {tab === "redline" && <RedlinePane />}
        {tab === "skills" && <SkillsPane />}
        {tab === "env" && <EnvPane />}
        {tab === "editor" && (
          <div className="flex h-full flex-col">
            {activeFile ? (
              <>
                <div className="flex items-center gap-2 border-b border-[#22222c] px-3 py-1.5 text-[11px] text-muted">
                  <span className="min-w-0 flex-1 truncate">{activeFile}</span>
                  <button
                    className="btn btn-primary px-2 py-0.5"
                    onClick={async () => {
                      await api.writeFile(activeFile, fileContent).catch((e) => showToast(String(e)));
                      showToast("Saved");
                      bumpTree();
                    }}
                  >
                    Save
                  </button>
                  <button className="text-muted hover:text-text" onClick={() => openFile(null)}>
                    ✕
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-hidden text-[12px]">
                  <CodeMirror
                    value={fileContent}
                    height="100%"
                    theme="dark"
                    basicSetup={{ lineNumbers: true, foldGutter: false }}
                    onChange={(v) => setFileContent(v)}
                  />
                </div>
              </>
            ) : (
              <div className="grid h-full place-items-center text-[12px] text-muted">
                Click a file in the left panel to open it.
              </div>
            )}
          </div>
        )}
      </div>
      {project && tab === "preview" && (
        <div className="border-t border-[#22222c] px-3 py-1 text-[10.5px] text-muted">{project.root}</div>
      )}
    </div>
  );
}

import Preview from "./Preview";
import TerminalPane from "./TerminalPane";
import GitPane from "./GitPane";
import MemoryPane from "./MemoryPane";
import EnvPane from "./EnvPane";
import RedlinePane from "./RedlinePane";
import SkillsPane from "./SkillsPane";
