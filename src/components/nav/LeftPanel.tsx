import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderPlus,
  FilePlus,
  RefreshCw,
  Search,
  Trash2,
  Pencil,
  FolderOpen,
  PanelLeftClose,
  FolderOpen as FolderOpenIcon,
} from "lucide-react";
import { api, FsEntry } from "../../lib/api";
import { useApp } from "../../store/useApp";

function TreeNode({ entry, depth }: { entry: FsEntry; depth: number }) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FsEntry[] | null>(null);
  const openFile = useApp((s) => s.openFile);
  const bumpTree = useApp((s) => s.bumpTree);
  const activeProject = useApp((s) => s.activeProject());
  const showToast = useApp((s) => s.showToast);
  const fileTreeVersion = useApp((s) => s.fileTreeVersion);

  const load = async () => {
    if (!activeProject) return;
    try {
      const rel = entry.path.slice(activeProject.root.length).replace(/^[\\/]/, "");
      setChildren(await api.listDir(activeProject.root, rel));
    } catch {
      setChildren([]);
    }
  };

  useEffect(() => {
    if (expanded) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, fileTreeVersion]);

  const del = async () => {
    if (!confirm(`Delete ${entry.name}?`)) return;
    await api.deletePath(entry.path).catch((e) => showToast(String(e)));
    bumpTree();
  };

  const rename = async () => {
    const name = prompt("New name", entry.name);
    if (!name) return;
    const to = entry.path.slice(0, entry.path.length - entry.name.length) + name;
    await api.renamePath(entry.path, to).catch((e) => showToast(String(e)));
    bumpTree();
  };

  return (
    <div>
      <div
        className="flex cursor-pointer items-center gap-1 rounded px-1 py-[3px] hover:bg-elev"
        style={{ paddingLeft: 4 + depth * 12 }}
        onClick={() => {
          if (entry.is_dir) setExpanded((v) => !v);
          else openFile(entry.path);
        }}
      >
        {entry.is_dir ? (
          expanded ? (
            <ChevronDown size={13} className="shrink-0 text-muted" />
          ) : (
            <ChevronRight size={13} className="shrink-0 text-muted" />
          )
        ) : (
          <FileIcon size={13} className="shrink-0 text-muted" />
        )}
        <span className="truncate text-[12.5px] text-text2">{entry.name}</span>
        <span className="ml-auto hidden gap-1 group-hover:flex">
          <button
            className="text-muted hover:text-text"
            onClick={(e) => {
              e.stopPropagation();
              rename();
            }}
          >
            <Pencil size={11} />
          </button>
          <button
            className="text-muted hover:text-err"
            onClick={(e) => {
              e.stopPropagation();
              del();
            }}
          >
            <Trash2 size={11} />
          </button>
        </span>
      </div>
      {entry.is_dir && expanded && children && (
        <div className="group">
          {children.map((c) => (
            <TreeNode key={c.path} entry={c} depth={depth + 1} />
          ))}
        </div>
      )}
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

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newRoot, setNewRoot] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ path: string; line: number; text: string }[] | null>(null);
  const [rootEntries, setRootEntries] = useState<FsEntry[]>([]);

  const startNewProject = async () => {
    try {
      const selected = await api.pickFolder("Select project folder");
      if (!selected) return;
      const root = selected;
      const existing = projects.find(
        (p) => p.root.trim().toLowerCase() === root.trim().toLowerCase()
      );
      if (existing) {
        await setActiveProject(existing.id);
        showToast(`Opened ${existing.name}`);
        setCreating(false);
        return;
      }
      const name =
        root.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() ||
        "New Project";
      const p = await api.createProject(name, root, "");
      await loadProjects();
      await setActiveProject(p.id);
      setCreating(false);
      showToast(`Created project: ${name}`);
    } catch (e) {
      showToast(String(e));
    }
  };

  const browseFolder = async () => {
    try {
      const selected = await api.pickFolder("Select project folder");
      if (selected) {
        setNewRoot(selected);
        if (!newName.trim()) {
          const name =
            selected.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() || "";
          setNewName(name);
        }
      }
    } catch (e) {
      showToast(String(e));
    }
  };

  useEffect(() => {
    if (activeProject) {
      api
        .listDir(activeProject.root, "")
        .then(setRootEntries)
        .catch(() => setRootEntries([]));
    }
  }, [activeProject, fileTreeVersion]);

  const doSearch = useMemo(
    () =>
      debounce(async (q: string) => {
        if (!activeProject || !q.trim()) {
          setHits(null);
          return;
        }
        try {
          setHits(await api.searchProject(activeProject.root, q));
        } catch {
          setHits([]);
        }
      }, 350),
    [activeProject]
  );

  const createProject = async () => {
    if (!newName.trim() || !newRoot.trim()) return;
    try {
      const p = await api.createProject(newName.trim(), newRoot.trim(), "");
      await loadProjects();
      await setActiveProject(p.id);
      setCreating(false);
      setNewName("");
      setNewRoot("");
    } catch (e) {
      showToast(String(e));
    }
  };

  const newFileOrDir = async (isDir: boolean) => {
    if (!activeProject) return;
    const name = prompt(isDir ? "New folder name" : "New file name");
    if (!name) return;
    const path = activeProject.root.replace(/[\\/]+$/, "") + "/" + name;
    try {
      if (isDir) await api.createDir(path);
      else await api.writeFile(path, "");
      bumpTree();
    } catch (e) {
      showToast(String(e));
    }
  };

  return (
    <div className="flex h-full flex-col border-r border-[#22222c] bg-panel">
      <div className="flex items-center gap-1 px-2 py-2">
        <select
          className="input min-w-0 flex-1"
          value={activeProjectId ?? ""}
          onChange={(e) => setActiveProject(e.target.value || null)}
        >
          {projects.length === 0 && <option value="">No project</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button className="btn btn-ghost px-1.5" title="Open folder / New project" onClick={startNewProject}>
          +
        </button>
        <button className="btn btn-ghost px-1.5" title="Hide panel" onClick={onToggle}>
          <PanelLeftClose size={14} />
        </button>
      </div>

      {creating && (
        <div className="mx-2 mb-2 space-y-2 rounded-lg bg-elev p-2">
          <input className="input w-full" placeholder="Project name" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <div className="flex gap-1">
            <input
              className="input flex-1 min-w-0"
              placeholder="Folder path (e.g. C:\dev\my-app)"
              value={newRoot}
              onChange={(e) => setNewRoot(e.target.value)}
            />
            <button className="btn btn-ghost px-2" title="Browse for folder" onClick={browseFolder}>
              <FolderOpenIcon size={14} />
            </button>
          </div>
          <button className="btn btn-primary w-full justify-center" onClick={createProject}>
            Create project
          </button>
        </div>
      )}

      {activeProject && (
        <>
          <div className="relative mx-2 mb-2">
            <Search size={13} className="absolute left-2.5 top-2 text-muted" />
            <input
              className="input w-full pl-7"
              placeholder="Search project…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                doSearch(e.target.value);
              }}
            />
          </div>

          {hits !== null && (
            <div className="mx-2 mb-2 max-h-56 overflow-y-auto rounded-lg bg-bg2">
              {hits.length === 0 && <div className="p-2 text-[11.5px] text-muted">No matches</div>}
              {hits.map((h, i) => (
                <button
                  key={i}
                  className="block w-full truncate px-2 py-1 text-left text-[11.5px] text-text2 hover:bg-elev"
                  onClick={() => openFile(h.path)}
                  title={`${h.path}:${h.line}`}
                >
                  <span className="text-fuchsia2">{h.path.split(/[\\/]/).pop()}:{h.line}</span> {h.text}
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-1 px-2 pb-1">
            <button className="btn btn-ghost px-1.5" title="New file" onClick={() => newFileOrDir(false)}>
              <FilePlus size={14} />
            </button>
            <button className="btn btn-ghost px-1.5" title="New folder" onClick={() => newFileOrDir(true)}>
              <FolderPlus size={14} />
            </button>
            <button className="btn btn-ghost px-1.5" title="Refresh" onClick={() => bumpTree()}>
              <RefreshCw size={13} />
            </button>
            <button
              className="btn btn-ghost px-1.5"
              title="Open in Explorer"
              onClick={() => api.openInExplorer(activeProject.root)}
            >
              <FolderOpen size={14} />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
            {rootEntries.map((e) => (
              <TreeNode key={e.path} entry={e} depth={0} />
            ))}
            <div className="px-2 pt-2 text-[10.5px] text-muted" title={activeProject.root}>
              <span className="truncate">{width > 220 ? activeProject.root : "…"}</span>
            </div>
          </div>
        </>
      )}

      {!activeProject && (
        <div className="flex flex-col items-center justify-center px-4 py-8 text-center text-muted">
          <FolderOpen size={36} className="mb-2 text-muted/60" />
          <p className="mb-3 text-[12.5px] font-medium text-text2">No project open</p>
          <button className="btn btn-primary text-xs" onClick={startNewProject}>
            <FolderOpenIcon size={14} className="mr-1.5 inline" /> Open Folder
          </button>
        </div>
      )}
    </div>
  );
}

function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let t: any;
  return ((...args: any[]) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  }) as T;
}
