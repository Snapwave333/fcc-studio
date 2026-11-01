import { useCallback, useEffect, useState } from "react";
import { Check, GitBranch, GitCommitHorizontal, Plus, RefreshCw, RotateCcw, Undo2 } from "lucide-react";
import { api, CommitInfo, GitEntry, GitStatus } from "../../lib/api";
import { useApp } from "../../store/useApp";
import { confirmDialog, promptDialog } from "../../lib/dialog";
import { relativeTime } from "../../lib/format";

function code(e: GitEntry, side: "staged" | "unstaged"): string {
  if (e.untracked) return "U";
  const c = side === "staged" ? e.x : e.y;
  return c.trim() || "M";
}

function codeColor(c: string): string {
  if (c === "A" || c === "U") return "text-ok";
  if (c === "D") return "text-err";
  if (c === "R") return "text-fuchsia2";
  return "text-[#e3b341]";
}

function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) return <div className="rounded-lg bg-[#0c0c10] p-2 text-[11px] text-muted">No textual diff.</div>;
  return (
    <pre className="max-h-72 overflow-auto rounded-lg bg-[#0c0c10] p-2 font-mono text-[11px] leading-snug">
      {diff.split("\n").map((l, i) => (
        <div
          key={i}
          className={
            l.startsWith("+") && !l.startsWith("+++")
              ? "bg-ok/10 text-ok"
              : l.startsWith("-") && !l.startsWith("---")
              ? "bg-err/10 text-err"
              : l.startsWith("@@")
              ? "text-fuchsia2"
              : "text-muted"
          }
        >
          {l || " "}
        </div>
      ))}
    </pre>
  );
}

export default function GitPane() {
  const project = useApp((s) => s.activeProject());
  const showToast = useApp((s) => s.showToast);
  const visible = useApp((s) => s.rightTab === "git");
  const treeVersion = useApp((s) => s.fileTreeVersion);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [log, setLog] = useState<CommitInfo[]>([]);
  const [diff, setDiff] = useState<string>("");
  const [selected, setSelected] = useState<string | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const p = useApp.getState().activeProject();
    if (!p) return;
    const st = await api.gitStatus(p.root).catch(() => null);
    if (useApp.getState().activeProjectId !== p.id) return;
    setStatus(st);
    if (st?.repo) {
      const [l, b] = await Promise.all([api.gitLog(p.root, 30).catch(() => []), api.gitBranches(p.root).catch(() => [])]);
      setLog(l);
      setBranches(b);
    } else {
      setLog([]);
      setBranches([]);
    }
  }, []);

  useEffect(() => {
    setSelected(null);
    setDiff("");
    setStatus(null);
  }, [project?.id]);

  useEffect(() => {
    if (!visible) return;
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh, visible, project?.id]);

  useEffect(() => {
    if (visible) refresh();
  }, [treeVersion]);

  const showDiff = async (path: string) => {
    if (!project) return;
    setSelected(path);
    setDiff(await api.gitDiff(project.root, path).catch((e) => String(e)));
  };

  const act = async (fn: () => Promise<any>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) showToast(ok);
      await refresh();
      if (selected && project) setDiff(await api.gitDiff(project.root, selected).catch(() => ""));
    } catch (e) {
      showToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!project) return <div className="p-4 text-[12px] text-muted">Select a project.</div>;
  if (!status) return <div className="p-4 text-[12px] text-muted">Reading repository…</div>;
  if (!status.repo)
    return (
      <div className="space-y-3 p-4 text-[12.5px] text-muted">
        <p>This folder is not a git repository yet.</p>
        <button className="btn btn-primary" onClick={() => act(() => api.gitInit(project.root), "Repository initialized")}>
          Initialize repository
        </button>
      </div>
    );

  const staged = status.entries.filter((e) => e.staged);
  const unstaged = status.entries.filter((e) => e.unstaged);
  const root = project.root;

  const commit = () => {
    const msg = commitMsg.trim();
    if (!msg || staged.length === 0) return;
    act(async () => {
      await api.gitCommit(root, msg);
      setCommitMsg("");
    }, "Committed");
  };

  return (
    <div className="flex h-full flex-col text-[12px]">
      <div className="flex items-center gap-2 border-b border-[#22222c] px-3 py-2">
        <GitBranch size={13} className="text-fuchsia2" />
        <select
          className="input max-w-[160px] py-0.5"
          value={status.branch}
          onChange={(e) => act(() => api.gitCheckout(root, e.target.value), `Switched to ${e.target.value}`)}
        >
          {branches.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
          {!branches.includes(status.branch) && <option value={status.branch}>{status.branch}</option>}
        </select>
        <button
          className="btn btn-ghost px-1.5"
          title="New branch"
          onClick={async () => {
            const name = await promptDialog("Create branch", { placeholder: "feature/my-change", confirmLabel: "Create & switch" });
            if (name) act(() => api.gitNewBranch(root, name), `Created ${name}`);
          }}
        >
          <Plus size={13} />
        </button>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted" title={status.upstream}>
          {status.upstream || "no upstream"}
        </span>
        <span className="text-[11px] text-muted" title="ahead / behind upstream">
          ↑{status.ahead} ↓{status.behind}
        </span>
        <button className="btn btn-ghost px-1.5" title="Refresh" onClick={() => refresh()}>
          <RefreshCw size={12} className={busy ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {staged.length > 0 && (
          <div>
            <div className="mb-1 flex items-center text-[10.5px] font-semibold uppercase tracking-wider text-muted">
              <span className="flex-1">staged ({staged.length})</span>
              <button className="normal-case text-muted hover:text-text" onClick={() => act(() => api.gitUnstage(root, staged.map((e) => e.path)))}>
                unstage all
              </button>
            </div>
            {staged.map((e) => (
              <div key={`s-${e.path}`} className={`group flex items-center gap-2 rounded px-1.5 py-[3px] hover:bg-elev ${selected === e.path ? "bg-elev" : ""}`}>
                <span className={`w-3 text-center font-mono text-[10.5px] ${codeColor(code(e, "staged"))}`}>{code(e, "staged")}</span>
                <button className="min-w-0 flex-1 truncate text-left text-text2" onClick={() => showDiff(e.path)} title={e.path}>
                  {e.path}
                </button>
                <button className="invisible text-muted hover:text-text group-hover:visible" title="Unstage" onClick={() => act(() => api.gitUnstage(root, [e.path]))}>
                  <Undo2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {unstaged.length > 0 && (
          <div>
            <div className="mb-1 flex items-center text-[10.5px] font-semibold uppercase tracking-wider text-muted">
              <span className="flex-1">changes ({unstaged.length})</span>
              <button className="normal-case text-muted hover:text-text" onClick={() => act(() => api.gitStage(root, []))}>
                stage all
              </button>
            </div>
            {unstaged.map((e) => (
              <div key={`u-${e.path}`} className={`group flex items-center gap-2 rounded px-1.5 py-[3px] hover:bg-elev ${selected === e.path ? "bg-elev" : ""}`}>
                <span className={`w-3 text-center font-mono text-[10.5px] ${codeColor(code(e, "unstaged"))}`}>{code(e, "unstaged")}</span>
                <button className="min-w-0 flex-1 truncate text-left text-text2" onClick={() => showDiff(e.path)} title={e.path}>
                  {e.path}
                </button>
                <button className="invisible text-muted hover:text-ok group-hover:visible" title="Stage" onClick={() => act(() => api.gitStage(root, [e.path]))}>
                  <Check size={12} />
                </button>
                <button
                  className="invisible text-muted hover:text-err group-hover:visible"
                  title={e.untracked ? "Delete untracked file" : "Discard changes"}
                  onClick={async () => {
                    const ok = await confirmDialog(e.untracked ? `Delete ${e.path}?` : `Discard changes to ${e.path}?`, {
                      message: "This cannot be undone.",
                      confirmLabel: e.untracked ? "Delete" : "Discard",
                      danger: true,
                    });
                    if (ok) act(() => api.gitDiscard(root, e.path));
                  }}
                >
                  <RotateCcw size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {status.entries.length === 0 && <div className="text-[12px] text-muted">Working tree clean.</div>}

        {selected && (
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="truncate text-[10.5px] font-semibold uppercase tracking-wider text-muted">diff · {selected}</span>
              <button className="text-muted hover:text-text" onClick={() => setSelected(null)}>
                ✕
              </button>
            </div>
            <DiffView diff={diff} />
          </div>
        )}

        <div>
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted">history ({log.length})</div>
          {log.length === 0 && <div className="px-1.5 text-muted">No commits yet.</div>}
          {log.map((c) => (
            <div key={c.hash} className="flex items-baseline gap-2 rounded px-1.5 py-[3px] hover:bg-elev" title={`${c.hash}\n${c.author} · ${new Date(c.date).toLocaleString()}`}>
              <span className="font-mono text-[10.5px] text-fuchsia2">{c.hash.slice(0, 7)}</span>
              <span className="min-w-0 flex-1 truncate text-text2">{c.subject}</span>
              <span className="shrink-0 text-[10.5px] text-muted">{relativeTime(c.date)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-1 border-t border-[#22222c] p-2">
        <input
          className="input min-w-0 flex-1"
          placeholder={staged.length ? `Commit ${staged.length} staged file${staged.length > 1 ? "s" : ""}…` : "Stage changes to commit"}
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
        />
        <button className="btn btn-primary" disabled={!commitMsg.trim() || staged.length === 0 || busy} onClick={commit}>
          <GitCommitHorizontal size={13} /> Commit
        </button>
      </div>
    </div>
  );
}
