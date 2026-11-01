import { useEffect, useMemo, useRef, useState } from "react";
import { File as FileIcon, Search } from "lucide-react";
import { api } from "../../lib/api";
import { useApp } from "../../store/useApp";
import { joinPath } from "../../lib/format";

export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 1;
  let ti = 0;
  let score = 0;
  let streak = 0;
  const base = t.lastIndexOf("/") + 1;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === ch) {
        found = ti;
        break;
      }
      ti++;
      streak = 0;
    }
    if (found < 0) return -1;
    streak++;
    score += 1 + streak * 2;
    if (found === 0 || t[found - 1] === "/" || t[found - 1] === "." || t[found - 1] === "-" || t[found - 1] === "_") score += 6;
    if (found >= base) score += 3;
    ti++;
  }
  return score - t.length * 0.05;
}

export function rankFiles(query: string, files: string[], limit = 50): string[] {
  if (!query.trim()) return files.slice(0, limit);
  return files
    .map((f) => [f, fuzzyScore(query.trim(), f)] as const)
    .filter(([, s]) => s >= 0)
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .slice(0, limit)
    .map(([f]) => f);
}

export default function QuickOpen({ onClose }: { onClose: () => void }) {
  const project = useApp((s) => s.activeProject());
  const openFile = useApp((s) => s.openFile);
  const [files, setFiles] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!project) return;
    api
      .listFiles(project.root)
      .then(setFiles)
      .catch(() => setFiles([]))
      .finally(() => setLoading(false));
  }, [project?.root]);

  const results = useMemo(() => rankFiles(query, files), [query, files]);

  useEffect(() => setIndex(0), [query]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const choose = (rel: string | undefined) => {
    if (!rel || !project) return;
    openFile(joinPath(project.root, project.root.includes("\\") && !project.root.includes("/") ? rel.replace(/\//g, "\\") : rel));
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[90] flex justify-center bg-black/40 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Quick open" className="h-fit w-[560px] max-w-[92vw] overflow-hidden rounded-2xl border border-[#2c2c38] bg-elev shadow-2xl">
        <div className="flex items-center gap-2 border-b border-[#2c2c38] px-3 py-2.5">
          <Search size={14} className="text-muted" />
          <input
            autoFocus
            className="min-w-0 flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-muted"
            placeholder={project ? `Go to file in ${project.name}…` : "Open a project first"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(results.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(results[index]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
          />
          <span className="text-[10.5px] text-muted">{loading ? "indexing…" : `${files.length} files`}</span>
        </div>
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto p-1">
          {results.map((f, i) => {
            const slash = f.lastIndexOf("/");
            return (
              <button
                key={f}
                data-idx={i}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left ${i === index ? "bg-select" : "hover:bg-panel"}`}
                onMouseEnter={() => setIndex(i)}
                onClick={() => choose(f)}
              >
                <FileIcon size={13} className="shrink-0 text-muted" />
                <span className="truncate text-[12.5px] text-text">{f.slice(slash + 1)}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted">{slash > 0 ? f.slice(0, slash) : ""}</span>
              </button>
            );
          })}
          {!loading && results.length === 0 && <div className="px-3 py-3 text-[12px] text-muted">No matching files.</div>}
        </div>
      </div>
    </div>
  );
}
