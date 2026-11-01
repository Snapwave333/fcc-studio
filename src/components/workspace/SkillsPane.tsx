import { useEffect, useState } from "react";
import { Trash2, X } from "lucide-react";
import { api, SkillInfo } from "../../lib/api";
import { useApp } from "../../store/useApp";
import { confirmDialog, promptDialog } from "../../lib/dialog";

export default function SkillsPane() {
  const project = useApp((s) => s.activeProject());
  const showToast = useApp((s) => s.showToast);
  const pendingSkill = useApp((s) => s.pendingSkill);
  const setPendingSkill = useApp((s) => s.setPendingSkill);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [selected, setSelected] = useState<SkillInfo | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);

  const load = async () => {
    const res = await api.skillsList(project?.root ?? null).catch(() => null);
    if (res) setSkills(res.skills);
    return res?.skills ?? [];
  };

  const create = async (scope: "global" | "project") => {
    const name = await promptDialog(scope === "global" ? "New global skill" : `New skill in ${project?.name}`, {
      placeholder: "lowercase-with-dashes",
      message: scope === "global" ? "Saved to ~/.claude/skills and available in every project." : "Saved to .claude/skills inside this project.",
      confirmLabel: "Create",
    });
    if (!name) return;
    try {
      const path = await api.skillsCreate(scope, project?.root ?? null, name);
      const fresh = await load();
      const match = fresh.find((x) => x.path === path);
      if (match) await open(match);
      showToast(`Skill created`);
    } catch (e) {
      showToast(String(e));
    }
  };

  const select = async (s: SkillInfo) => {
    if (dirty && selected && selected.path !== s.path) {
      const ok = await confirmDialog("Discard unsaved skill edits?", { confirmLabel: "Discard", danger: true });
      if (!ok) return;
    }
    await open(s);
  };

  useEffect(() => {
    load();
  }, [project?.id]);

  const open = async (s: SkillInfo) => {
    const c = await api.skillsRead(s.path).catch((e) => {
      showToast(String(e));
      return "";
    });
    setSelected(s);
    setContent(c);
    setDirty(false);
  };

  const saveSkill = async () => {
    if (!selected) return;
    try {
      await api.skillsWrite(selected.path, content);
      setDirty(false);
      showToast("Skill saved");
      await load();
    } catch (e) {
      showToast(`Save failed: ${String(e)}`);
    }
  };

  return (
    <div className="flex h-full">
      <div className="flex w-56 min-w-0 flex-col overflow-y-auto border-r border-[#22222c] p-2">
        <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted">
          skills ({skills.length})
        </div>
        {skills.length === 0 && <div className="px-1.5 py-1 text-[11px] text-muted">No skills found yet.</div>}
        {skills.map((s) => (
          <div
            key={s.path}
            className={`group flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 hover:bg-elev ${
              selected?.path === s.path ? "bg-elev" : ""
            }`}
            onClick={() => select(s)}
          >
            <span className={`chip shrink-0 px-1.5 py-0 text-[9.5px] ${s.scope === "global" ? "" : "text-fuchsia2"}`}>
              {s.scope === "global" ? "G" : "P"}
            </span>
            <span className="min-w-0 flex-1 truncate text-[11.5px] text-text2">{s.name}</span>
            <button
              className="hidden text-muted hover:text-err group-hover:block"
              title="Delete skill"
              onClick={async (e) => {
                e.stopPropagation();
                const ok = await confirmDialog(`Delete skill “${s.name}”?`, {
                  message: "Its folder and SKILL.md are permanently deleted.",
                  confirmLabel: "Delete",
                  danger: true,
                });
                if (!ok) return;
                await api.skillsDelete(s.path).catch((er) => showToast(String(er)));
                if (selected?.path === s.path) setSelected(null);
                await load();
              }}
            >
              <Trash2 size={11} />
            </button>
          </div>
        ))}
        <div className="mt-2 space-y-1">
          <button className="btn btn-ghost w-full justify-center text-[11px]" onClick={() => create("global")}>
            + global skill
          </button>
          {project && (
            <button className="btn btn-ghost w-full justify-center text-[11px]" onClick={() => create("project")}>
              + project skill
            </button>
          )}
        </div>
        <p className="mt-2 px-1 text-[10px] leading-relaxed text-muted">
          G = ~/.claude/skills · P = project/.claude/skills. The agent loads these natively on every
          run in this project.
        </p>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <>
            <div className="flex items-center gap-2 border-b border-[#22222c] px-3 py-1.5 text-[11px] text-muted">
              <span className="min-w-0 flex-1 truncate">{selected.name}</span>
              <button
                className={`btn px-2 py-0.5 ${pendingSkill === selected.name ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setPendingSkill(pendingSkill === selected.name ? null : selected.name)}
                title="Attach this skill to your next message"
              >
                {pendingSkill === selected.name ? "Attached ✓" : "Use in prompt"}
              </button>
              <button
                className="btn btn-primary px-2 py-0.5"
                disabled={!dirty}
                onClick={saveSkill}
              >
                Save
              </button>
              <button className="text-muted hover:text-text" onClick={() => setSelected(null)}>
                <X size={13} />
              </button>
            </div>
            <textarea
              className="min-h-0 flex-1 resize-none bg-[#0c0c10] p-3 font-mono text-[11.5px] leading-relaxed text-text2 outline-none"
              value={content}
              spellCheck={false}
              onChange={(e) => {
                setContent(e.target.value);
                setDirty(true);
              }}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                  e.preventDefault();
                  if (dirty) saveSkill();
                }
              }}
            />
          </>
        ) : (
          <div className="grid h-full place-items-center text-[12px] text-muted">
            Select a skill to view or edit its SKILL.md.
          </div>
        )}
      </div>
    </div>
  );
}
