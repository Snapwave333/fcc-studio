import { useCallback, useEffect, useState } from "react";
import { Check, GitBranch, RotateCcw, Undo2 } from "lucide-react";
import { api, CommitInfo, GitStatus } from "../../lib/api";
import { useApp } from "../../store/useApp";

export default function GitPane() {
  const project = useApp((s) => s.activeProject());
  const showToast = useApp((s) => s.showToast);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [log, setLog] = useState<CommitInfo[]>([]);
  const [diff, setDiff] = useState<string>("");
  const [selected, setSelected] = useState<string | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [newBranch, setNewBranch] = useState("");

  const refresh = useCallback(async () => {
    if (!project) return;
    const st = await api.gitStatus(project.root).catch(() => null);
    setStatus(st);
    if (st?.repo) {
      setLog(await api.gitLog(project.root, 30).catch(() => []));
      setBranches(await api.gitBranches(project.root).catch(() => []));
    }
  }, [project?.id]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const showDiff = async (path: string) => {
    if (!project) return;
    setSelected(path);
    setDiff(await api.gitDiff(project.root, path).catch((e) => String(e)));
  };

  const act = async (fn: () => Promise<any>) => {
    try {
      await fn();
      await refresh();
    } catch (e) {
      showToast(String(e));
    }
  };

  if (!project) return <div className="p-4 text-[12px] text-muted">Select a project.</div>;
  if (!status?.repo)
    return (
      <div className="space-y-3 p-4 text-[12.5px] text-muted">
        <p>This folder is not a git repository yet.</p>
        <button className="btn btn-primary" onClick={() => act(() => api.gitInit(project.root))}>
          Initialize repository
        </button>
      </div>
    );

  const staged = status.entries.filter((e) => e.staged);
  const unstaged = status.entries.filter((e) => !e.staged);

  return (
    <div className="flex h-full flex-col text-[12px]">
      <div className="flex items-center gap-2 border-b border-[#22222c] px-3 py-2">
        <GitBranch size={13} className="text-fuchsia2" />
        <select
          className="input py-0.5"
          value={status.branch}
          onChange={(e) => act(() => api.gitCheckout(project.root, e.target.value))}
        >
          {branches.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
          {!branches.includes(status.branch) && <option value={status.branch}>{status.branch}</option>}
        </select>
        <input
          className="input w-28 py-0.5"
          placeholder="new branch…"
          value={newBranch}
          onChange={(e) => setNewBranch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && newBranch.trim()) {
              act(() => api.gitNewBranch(project.root, newBranch.trim()));
              setNewBranch("");
            }
          }}
        />
        <span className="min-w-0 flex-1" />
        <span className="text-[11px] text-muted">
          ↑{status.ahead} ↓{status.behind}
        </span>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {staged.length > 0 && (
          <div>
            <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted">
              staged ({staged.length})
            </div>
            {staged.map((e) => (
              <div key={e.path} className="group flex items-center gap-2 rounded px-1.5 py-[3px] hover:bg-elev">
                <span className="chip px-1.5 py-0 text-[10px] text-ok">{e.x}{e.y}</span>
                <button className="min-w-0 flex-1 truncate text-left text-text2" onClick={() => showDiff(e.path)}>
                  {e.path}
                </button>
                <button
                  className="hidden text-muted hover:text-text group-hover:block"
                  title="Unstage"
                  onClick={() => act(() => api.gitUnstage(project.root, [e.path]))}
                >
                  <Undo2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {unstaged.length > 0 && (
          <div>
            <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted">
              changes ({unstaged.length})
            </div>
            {unstaged.map((e) => (
              <div key={e.path} className="group flex items-center gap-2 rounded px-1.5 py-[3px] hover:bg-elev">
                <span className="chip px-1.5 py-0 text-[10px] text-fuchsia2">{e.x}{e.y}</span>
                <button className="min-w-0 flex-1 truncate text-left text-text2" onClick={() => showDiff(e.path)}>
                  {e.path}
                </button>
                <button
                  className="hidden text-muted hover:text-ok group-hover:block"
                  title="Stage"
                  onClick={() => act(() => api.gitStage(project.root, [e.path]))}
                >
                  <Check size={12} />
                </button>
                <button
                  className="hidden text-muted hover:text-err group-hover:block"
                  title="Discard changes"
                  onClick={() => {
                    if (confirm(`Discard changes to ${e.path}?`)) act(() => api.gitDiscard(project.root, e.path));
                  }}
                >
                  <RotateCcw size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {status.entries.length === 0 && (
          <div className="text-[12px] text-muted">Working tree clean.</div>
        )}

        {selected && (
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted">diff · {selected}</span>
              <button className="text-muted hover:text-text" onClick={() => setSelected(null)}>✕</button>
            </div>
            <pre className="max-h-64 overflow-auto rounded-lg bg-[#0c0c10] p-2 text-[11px] leading-snug">
              {diff
                .split("\n")
                .map((l, i) => (
                  <div
                    key={i}
                    className={
                      l.startsWith("+") && !l.startsWith("+++")
                        ? "text-ok"
                        : l.startsWith("-") && !l.startsWith("---")
                        ? "text-err"
                        : "text-muted"
                    }
                  >
                    {l || " "}
                  </div>
                ))}
            </pre>
          </div>
        )}

        <div>
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted">
            history ({log.length})
          </div>
          {log.map((c) => (
            <div key={c.hash} className="flex items-baseline gap-2 rounded px-1.5 py-[3px] hover:bg-elev">
              <span className="font-mono text-[10.5px] text-fuchsia2">{c.hash.slice(0, 7)}</span>
              <span className="min-w-0 flex-1 truncate text-text2">{c.subject}</span>
              <span className="shrink-0 text-[10.5px] text-muted">{c.author}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-1 border-t border-[#22222c] p-2">
        <input
          className="input min-w-0 flex-1"
          placeholder="Commit message…"
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && commitMsg.trim()) {
              act(async () => {
                await api.gitCommit(project.root, commitMsg.trim());
                setCommitMsg("");
              });
            }
          }}
        />
        <button
          className="btn btn-primary"
          disabled={!commitMsg.trim() || staged.length === 0}
          onClick={() =>
            act(async () => {
              await api.gitCommit(project.root, commitMsg.trim());
              setCommitMsg("");
            })
          }
        >
          Commit
        </button>
        <button
          className="btn btn-ghost"
          title="Stage all changes"
          onClick={() => act(() => api.gitStage(project.root, status.entries.filter((e) => !e.staged).map((e) => e.path)))}
        >
          Stage all
        </button>
      </div>
    </div>
  );
}
