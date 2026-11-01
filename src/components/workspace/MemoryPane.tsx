import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { api, MemoryEntry } from "../../lib/api";
import { useApp } from "../../store/useApp";

export default function MemoryPane() {
  const project = useApp((s) => s.activeProject());
  const showToast = useApp((s) => s.showToast);
  const patchProject = useApp((s) => s.patchProject);
  const [scope, setScope] = useState<"project" | "global">("project");
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState("note");
  const [editing, setEditing] = useState<string | null>(null);
  const [instructions, setInstructions] = useState(project?.instructions ?? "");

  useEffect(() => setInstructions(project?.instructions ?? ""), [project?.id]);

  const load = async () => {
    const key = scope === "global" ? "global" : (project?.id ?? "");
    if (!key) return setEntries([]);
    setEntries(await api.memoryList(key).catch(() => []));
  };

  useEffect(() => {
    load();
  }, [scope, project?.id]);

  const save = async () => {
    const key = scope === "global" ? "global" : (project?.id ?? "");
    if (!key || !title.trim()) return;
    try {
      await api.memorySave(editing, key, kind, title.trim(), body);
      setTitle("");
      setBody("");
      setEditing(null);
      await load();
    } catch (e) {
      showToast(String(e));
    }
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto p-3 text-[12px]">
      {project && (
        <div className="mb-4">
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted">
            project instructions (sent with every prompt)
          </div>
          <textarea
            className="input min-h-20 w-full resize-y"
            value={instructions}
            placeholder="Stack, conventions, commands the agent should know…"
            onChange={(e) => setInstructions(e.target.value)}
          />
          <button
            className="btn btn-primary mt-1.5"
            disabled={instructions === project.instructions}
            onClick={async () => {
              try {
                await patchProject(project.id, { instructions });
                showToast("Instructions saved");
              } catch (e) {
                showToast(String(e));
              }
            }}
          >
            Save instructions
          </button>
        </div>
      )}

      <div className="mb-2 flex items-center gap-1">
        {(["project", "global"] as const).map((s) => (
          <button
            key={s}
            className={`btn ${scope === s ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setScope(s)}
          >
            {s} memory
          </button>
        ))}
      </div>

      <div className="mb-3 space-y-1.5 rounded-xl border border-[#22222c] bg-panel p-2">
        <input className="input w-full" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea
          className="input min-h-14 w-full resize-y"
          placeholder="Details…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <div className="flex gap-1">
          <select className="input w-24 py-0.5" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="note">note</option>
            <option value="decision">decision</option>
            <option value="convention">convention</option>
            <option value="bug">bug</option>
            <option value="task">task</option>
          </select>
          <button className="btn btn-primary flex-1 justify-center" onClick={save} disabled={!title.trim()}>
            {editing ? "Update memory" : "Add memory"}
          </button>
          {editing && (
            <button
              className="btn btn-ghost"
              onClick={() => {
                setEditing(null);
                setTitle("");
                setBody("");
                setKind("note");
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        {entries.map((m) => (
          <div key={m.id} className="group rounded-lg border border-[#22222c] bg-panel p-2">
            <div className="flex items-center gap-2">
              <span className="chip">{m.kind}</span>
              <span className="min-w-0 flex-1 truncate font-medium text-text2">{m.title}</span>
              <button
                className="hidden text-muted hover:text-text group-hover:block"
                onClick={() => {
                  setEditing(m.id);
                  setTitle(m.title);
                  setBody(m.body);
                  setKind(m.kind);
                }}
              >
                edit
              </button>
              <button
                className="hidden text-muted hover:text-err group-hover:block"
                onClick={async () => {
                  if (!confirm(`Delete memory "${m.title}"?`)) return;
                  await api.memoryDelete(m.id).catch((e) => showToast(String(e)));
                  if (editing === m.id) {
                    setEditing(null);
                    setTitle("");
                    setBody("");
                  }
                  await load();
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
            {m.body && <div className="mt-1 whitespace-pre-wrap text-[11.5px] text-muted">{m.body}</div>}
          </div>
        ))}
        {entries.length === 0 && <div className="text-[12px] text-muted">No memory entries in this scope yet.</div>}
      </div>
    </div>
  );
}
