import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { api, FsEntry } from "../../lib/api";
import { useApp } from "../../store/useApp";
import { confirmDialog, promptDialog } from "../../lib/dialog";
import { baseName, joinPath, relPath } from "../../lib/format";

interface TreeCtx {
  expanded: Set<string>;
  toggle: (path: string, open?: boolean) => void;
  git: GitMarks;
}

export interface GitMarks {
  files: Map<string, string>;
  dirs: Set<string>;
}

const normKey = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

export function buildGitMarks(root: string, entries: { path: string; x: string; y: string; untracked: boolean }[]): GitMarks {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const base = normKey(root);
  for (const e of entries) {
    const code = e.untracked ? "U" : e.x === "A" ? "A" : e.x === "D" || e.y === "D" ? "D" : e.x === "R" ? "R" : "M";
    const rel = e.path.replace(/\\/g, "/").replace(/\/+$/, "");
    files.set(`${base}/${rel.toLowerCase()}`, code);
    const segs = rel.split("/");
    for (let i = 1; i < segs.length; i++) dirs.add(`${base}/${segs.slice(0, i).join("/").toLowerCase()}`);
  }
  return { files, dirs };
}

const GIT_COLOR: Record<string, string> = { M: "text-[#e3b341]", U: "text-ok", A: "text-ok", D: "text-err", R: "text-fuchsia2" };

const HIDDEN = new Set([".git", ".DS_Store", "Thumbs.db"]);
const visibleEntries = (entries: FsEntry[]) => entries.filter((e) => !HIDDEN.has(e.name));

const TreeContext = createContext<TreeCtx>({ expanded: new Set(), toggle: () => {}, git: { files: new Map(), dirs: new Set() } });

function validName(name: string): string | null {
  const n = name.trim();
  if (!n || n === "." || n === ".." || /[<>:"|?*\x00-\x1f]/.test(n)) return null;
  return n;
}

async function createIn(dir: string, isDir: boolean): Promise<string | null> {
  const raw = await promptDialog(isDir ? "New folder" : "New file", {
    placeholder: isDir ? "components" : "src/index.ts",
    message: `Inside ${baseName(dir)}`,
    confirmLabel: "Create",
  });
  if (!raw) return null;
  const name = validName(raw);
  if (!name || name.split(/[\\/]/).some((seg) => seg === "..")) {
    useApp.getState().showToast("That name is not allowed");
    return null;
  }
  const path = joinPath(dir, name);
  try {
    if (isDir) await api.createDir(path);
    else await api.writeFile(path, "");
    useApp.getState().bumpTree();
    return path;
  } catch (e) {
    useApp.getState().showToast(String(e));
    return null;
  }
}

function TreeNode({ entry, depth }: { entry: FsEntry; depth: number }) {
  const { expanded, toggle, git } = useContext(TreeContext);
  const key = normKey(entry.path);
  const gitCode = entry.is_dir ? undefined : git.files.get(key);
  const dirChanged = entry.is_dir && git.dirs.has(key);
  const isOpen = entry.is_dir && expanded.has(entry.path);
  const [children, setChildren] = useState<FsEntry[] | null>(null);
  const openFile = useApp((s) => s.openFile);
  const activeFile = useApp((s) => s.activeFile);
  const bumpTree = useApp((s) => s.bumpTree);
  const showToast = useApp((s) => s.showToast);
  const fileTreeVersion = useApp((s) => s.fileTreeVersion);

  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    api
      .listDir(entry.path, "")
      .then((c) => alive && setChildren(visibleEntries(c)))
      .catch(() => alive && setChildren([]));
    return () => {
      alive = false;
    };
  }, [isOpen, fileTreeVersion, entry.path]);

  const del = async () => {
    const ok = await confirmDialog(`Delete ${entry.name}?`, {
      message: entry.is_dir ? "The folder and everything inside it will be permanently deleted." : "The file will be permanently deleted.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deletePath(entry.path);
      if (activeFile && (activeFile === entry.path || activeFile.startsWith(entry.path + "/") || activeFile.startsWith(entry.path + "\\"))) openFile(null);
    } catch (e) {
      showToast(String(e));
    }
    bumpTree();
  };

  const rename = async () => {
    const raw = await promptDialog(`Rename ${entry.name}`, { defaultValue: entry.name, confirmLabel: "Rename" });
    const name = raw ? validName(raw) : null;
    if (!name || name === entry.name || /[\\/]/.test(name)) return;
    const to = entry.path.slice(0, entry.path.length - entry.name.length) + name;
    try {
      await api.renamePath(entry.path, to);
      if (activeFile === entry.path) openFile(to);
    } catch (e) {
      showToast(String(e));
    }
    bumpTree();
  };

  const isActive = activeFile === entry.path;

  return (
    <div>
      <div
        className={`group flex cursor-pointer items-center gap-1 rounded px-1 py-[3px] hover:bg-elev ${isActive ? "bg-select/60" : ""}`}
        style={{ paddingLeft: 4 + depth * 12 }}
        title={entry.path}
        onClick={() => {
          if (entry.is_dir) toggle(entry.path);
          else openFile(entry.path);
        }}
      >
        {entry.is_dir ? (
          isOpen ? <ChevronDown size={13} className="shrink-0 text-muted" /> : <ChevronRight size={13} className="shrink-0 text-muted" />
        ) : (
          <span className="w-[13px] shrink-0" />
        )}
        {entry.is_dir ? (
          isOpen ? <FolderOpen size={13} className="shrink-0 text-fuchsia2/80" /> : <Folder size={13} className="shrink-0 text-fuchsia2/80" />
        ) : (
          <FileIcon size={13} className="shrink-0 text-muted" />
        )}
        <span
          className={`min-w-0 flex-1 truncate text-[12.5px] ${gitCode ? GIT_COLOR[gitCode] : dirChanged ? "text-[#e3b341]/90" : isActive ? "text-text" : "text-text2"} ${gitCode === "D" ? "line-through" : ""}`}
        >
          {entry.name}
        </span>
        {gitCode && <span className={`shrink-0 pr-1 font-mono text-[10px] group-hover:hidden ${GIT_COLOR[gitCode]}`}>{gitCode}</span>}
        {dirChanged && <span className="shrink-0 pr-1.5 text-[8px] text-[#e3b341] group-hover:hidden">●</span>}
        <span className="ml-auto hidden shrink-0 gap-1.5 pr-1 group-hover:flex">
          {entry.is_dir && (
            <button
              className="text-muted hover:text-text"
              title="New file here"
              onClick={async (e) => {
                e.stopPropagation();
                const p = await createIn(entry.path, false);
                if (p) {
                  toggle(entry.path, true);
                  openFile(p);
                }
              }}
            >
              <FilePlus size={11} />
            </button>
          )}
          <button
            className="text-muted hover:text-text"
            title="Rename"
            onClick={(e) => {
              e.stopPropagation();
              rename();
            }}
          >
            <Pencil size={11} />
          </button>
          <button
            className="text-muted hover:text-err"
            title="Delete"
            onClick={(e) => {
              e.stopPropagation();
              del();
            }}
          >
            <Trash2 size={11} />
          </button>
        </span>
      </div>
      {isOpen && children && (
        <div>
          {children.map((c) => (
            <TreeNode key={c.path} entry={c} depth={depth + 1} />
          ))}
          {children.length === 0 && (
            <div className="py-[2px] text-[11px] italic text-muted" style={{ paddingLeft: 30 + depth * 12 }}>
              empty
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProjectMenu({ onClose }: { onClose: () => void }) {
  const project = useApp((s) => s.activeProject());
  const updateProject = useApp((s) => s.updateProject);
  const removeProject = useApp((s) => s.removeProject);
  const showToast = useApp((s) => s.showToast);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose]);
  if (!project) return null;
  return (
    <div ref={ref} className="absolute left-2 right-2 top-11 z-40 rounded-xl border border-[#2c2c38] bg-elev p-1 shadow-2xl">
      <button
        className="block w-full rounded-lg px-2.5 py-1.5 text-left text-[12px] hover:bg-panel"
        onClick={async () => {
          onClose();
          const name = await promptDialog("Rename project", { defaultValue: project.name, confirmLabel: "Rename" });
          if (name) updateProject(project.id, { name }).catch((e) => showToast(String(e)));
        }}
      >
        Rename project
      </button>
      <button
        className="block w-full rounded-lg px-2.5 py-1.5 text-left text-[12px] hover:bg-panel"
        onClick={() => {
          onClose();
          api.openInExplorer(project.root).catch((e) => showToast(String(e)));
        }}
      >
        Reveal folder
      </button>
      <button
        className="block w-full rounded-lg px-2.5 py-1.5 text-left text-[12px] text-err hover:bg-panel"
        onClick={async () => {
          onClose();
          const ok = await confirmDialog(`Remove ${project.name} from Serenity?`, {
            message: "Conversations and project memory are removed from Serenity. Files on disk are not touched.",
            confirmLabel: "Remove",
            danger: true,
          });
          if (ok) removeProject(project.id).catch((e) => showToast(String(e)));
        }}
      >
        Remove from list
      </button>
    </div>
  );
}

export default function LeftPanel({ width, onToggle }: { width: number; onToggle: () => void }) {
  const projects = useApp((s) => s.projects);
  const activeProjectId = useApp((s) => s.activeProjectId);
  const setActiveProject = useApp((s) => s.setActiveProject);
  const loadProjects = useApp((s) => s.loadProjects);
  const activeProject = useApp((s) => s.activeProject());
  const showToast = useApp((s) => s.showToast);
  const bumpTree = useApp((s) => s.bumpTree);
  const fileTreeVersion = useApp((s) => s.fileTreeVersion);
  const openFile = useApp((s) => s.openFile);

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ path: string; line: number; text: string }[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [rootEntries, setRootEntries] = useState<FsEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const [git, setGit] = useState<GitMarks>({ files: new Map(), dirs: new Set() });
  const searchSeq = useRef(0);

  const treeCtx = useMemo<TreeCtx>(
    () => ({
      git,
      expanded,
      toggle: (path, open) =>
        setExpanded((prev) => {
          const next = new Set(prev);
          const want = open ?? !next.has(path);
          if (want) next.add(path);
          else next.delete(path);
          return next;
        }),
    }),
    [expanded, git]
  );

  useEffect(() => {
    const root = activeProject?.root;
    if (!root) {
      setGit({ files: new Map(), dirs: new Set() });
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      api
        .gitStatus(root)
        .then((st) => alive && setGit(st.repo ? buildGitMarks(root, st.entries) : { files: new Map(), dirs: new Set() }))
        .catch(() => {});
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [activeProject?.root, fileTreeVersion]);

  useEffect(() => {
    setExpanded(new Set());
    setQuery("");
    setHits(null);
  }, [activeProjectId]);

  useEffect(() => {
    if (!activeProject) {
      setRootEntries([]);
      return;
    }
    let alive = true;
    api
      .listDir(activeProject.root, "")
      .then((e) => alive && setRootEntries(visibleEntries(e)))
      .catch(() => alive && setRootEntries([]));
    return () => {
      alive = false;
    };
  }, [activeProject?.id, activeProject?.root, fileTreeVersion]);

  useEffect(() => {
    const root = activeProject?.root;
    const q = query.trim();
    if (!root || q.length < 2) {
      setHits(null);
      setSearching(false);
      return;
    }
    const mySeq = ++searchSeq.current;
    setSearching(true);
    const t = setTimeout(async () => {
      const res = await api.searchProject(root, q).catch(() => []);
      if (mySeq !== searchSeq.current) return;
      setHits(res);
      setSearching(false);
    }, 300);
    return () => clearTimeout(t);
  }, [query, activeProject?.root]);

  const openFolder = async () => {
    try {
      const root = await api.pickFolder("Select project folder");
      if (!root) return;
      const norm = (p: string) => p.trim().replace(/[\\/]+$/, "").toLowerCase();
      const existing = projects.find((p) => norm(p.root) === norm(root));
      if (existing) {
        await setActiveProject(existing.id);
        showToast(`Opened ${existing.name}`);
        return;
      }
      const name = baseName(root) || "New Project";
      const p = await api.createProject(name, root, "");
      await loadProjects();
      await setActiveProject(p.id);
      showToast(`Added project ${name}`);
    } catch (e) {
      showToast(String(e));
    }
  };

  return (
    <div className="relative flex h-full flex-col border-r border-[#22222c] bg-panel">
      <div className="flex items-center gap-1 px-2 py-2">
        <select
          className="input min-w-0 flex-1"
          value={activeProjectId ?? ""}
          onChange={(e) => setActiveProject(e.target.value || null)}
          aria-label="Project"
        >
          {projects.length === 0 && <option value="">No project</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button className="btn btn-ghost px-1.5" title="Open folder as project" onClick={openFolder}>
          <Plus size={14} />
        </button>
        {activeProject && (
          <button className="btn btn-ghost px-1.5" title="Project actions" onClick={() => setMenuOpen((v) => !v)}>
            <MoreHorizontal size={14} />
          </button>
        )}
        <button className="btn btn-ghost px-1.5" title="Hide panel" onClick={onToggle}>
          <PanelLeftClose size={14} />
        </button>
      </div>
      {menuOpen && <ProjectMenu onClose={() => setMenuOpen(false)} />}

      {activeProject && (
        <>
          <div className="relative mx-2 mb-2">
            <Search size={13} className="absolute left-2.5 top-2 text-muted" />
            <input
              className="input w-full pl-7 pr-7"
              placeholder="Search in project…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setQuery("");
              }}
            />
            {query && (
              <button className="absolute right-2 top-1.5 text-muted hover:text-text" onClick={() => setQuery("")} title="Clear search">
                {searching ? <RefreshCw size={12} className="animate-spin" /> : <X size={12} />}
              </button>
            )}
          </div>

          {hits !== null && (
            <div className="mx-2 mb-2 max-h-64 overflow-y-auto rounded-lg bg-bg2">
              <div className="sticky top-0 bg-bg2 px-2 py-1 text-[10.5px] text-muted">
                {hits.length >= 300 ? "300+ matches" : `${hits.length} match${hits.length === 1 ? "" : "es"}`}
              </div>
              {hits.map((h, i) => (
                <button
                  key={`${h.path}:${h.line}:${i}`}
                  className="block w-full truncate px-2 py-1 text-left text-[11.5px] text-text2 hover:bg-elev"
                  onClick={() => openFile(h.path)}
                  title={`${h.path}:${h.line}`}
                >
                  <span className="text-fuchsia2">
                    {relPath(activeProject.root, h.path)}:{h.line}
                  </span>{" "}
                  <span className="text-muted">{h.text.trim()}</span>
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-1 px-2 pb-1">
            <span className="min-w-0 flex-1 truncate text-[10.5px] font-semibold uppercase tracking-wider text-muted">files</span>
            <button
              className="btn btn-ghost px-1.5"
              title="New file"
              onClick={async () => {
                const p = await createIn(activeProject.root, false);
                if (p) openFile(p);
              }}
            >
              <FilePlus size={14} />
            </button>
            <button className="btn btn-ghost px-1.5" title="New folder" onClick={() => createIn(activeProject.root, true)}>
              <FolderPlus size={14} />
            </button>
            <button className="btn btn-ghost px-1.5" title="Refresh" onClick={() => bumpTree()}>
              <RefreshCw size={13} />
            </button>
            <button className="btn btn-ghost px-1.5" title="Collapse all" onClick={() => setExpanded(new Set())}>
              <ChevronRight size={13} />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
            <TreeContext.Provider value={treeCtx}>
              {rootEntries.map((e) => (
                <TreeNode key={e.path} entry={e} depth={0} />
              ))}
            </TreeContext.Provider>
            {rootEntries.length === 0 && <div className="px-2 py-1 text-[11.5px] text-muted">This folder is empty.</div>}
          </div>
          <div className="truncate border-t border-[#22222c] px-2 py-1 text-[10.5px] text-muted" title={activeProject.root}>
            {width > 200 ? activeProject.root : baseName(activeProject.root)}
          </div>
        </>
      )}

      {!activeProject && (
        <div className="flex flex-col items-center justify-center px-4 py-8 text-center text-muted">
          <FolderOpen size={36} className="mb-2 text-muted/60" />
          <p className="mb-3 text-[12.5px] font-medium text-text2">No project open</p>
          <button className="btn btn-primary text-xs" onClick={openFolder}>
            <FolderOpen size={14} /> Open Folder
          </button>
        </div>
      )}
    </div>
  );
}
