import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror, { EditorView, Extension, keymap } from "@uiw/react-codemirror";
import { RotateCcw, Save, X } from "lucide-react";
import { api } from "../../lib/api";
import { useApp } from "../../store/useApp";
import { confirmDialog } from "../../lib/dialog";

export function languageFor(path: string): string {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const ext = name.includes(".") ? name.split(".").pop()! : name;
  if (["ts", "tsx", "mts", "cts"].includes(ext)) return "ts";
  if (["js", "jsx", "mjs", "cjs"].includes(ext)) return "js";
  if (["css", "scss", "less"].includes(ext)) return "css";
  if (["html", "htm", "vue", "svelte"].includes(ext)) return "html";
  if (["json", "jsonc", "json5"].includes(ext) || name === ".prettierrc" || name === ".eslintrc") return "json";
  if (["md", "mdx", "markdown"].includes(ext)) return "md";
  if (["py", "pyi"].includes(ext)) return "py";
  if (ext === "rs") return "rs";
  return "";
}

async function loadLanguage(lang: string): Promise<Extension[]> {
  switch (lang) {
    case "ts":
    case "js": {
      const m = await import("@codemirror/lang-javascript");
      return [m.javascript({ jsx: true, typescript: lang === "ts" })];
    }
    case "css":
      return [(await import("@codemirror/lang-css")).css()];
    case "html":
      return [(await import("@codemirror/lang-html")).html()];
    case "json":
      return [(await import("@codemirror/lang-json")).json()];
    case "md":
      return [(await import("@codemirror/lang-markdown")).markdown()];
    case "py":
      return [(await import("@codemirror/lang-python")).python()];
    case "rs":
      return [(await import("@codemirror/lang-rust")).rust()];
    default:
      return [];
  }
}

const theme = EditorView.theme(
  {
    "&": { backgroundColor: "#101014", height: "100%" },
    ".cm-gutters": { backgroundColor: "#101014", borderRight: "1px solid #22222c", color: "#5d5867" },
    ".cm-activeLine": { backgroundColor: "#16161d" },
    ".cm-activeLineGutter": { backgroundColor: "#16161d" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "#512044 !important" },
    ".cm-cursor": { borderLeftColor: "#f000b8" },
    ".cm-content": { fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace' },
  },
  { dark: true }
);

export default function EditorPane() {
  const activeFile = useApp((s) => s.activeFile);
  const openFile = useApp((s) => s.openFile);
  const bumpTree = useApp((s) => s.bumpTree);
  const showToast = useApp((s) => s.showToast);
  const changeVersion = useApp((s) => s.changeVersion);
  const project = useApp((s) => s.activeProject());
  const [content, setContent] = useState("");
  const [saved, setSaved] = useState("");
  const [langExt, setLangExt] = useState<Extension[]>([]);
  const [externalChange, setExternalChange] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef({ content, saved, activeFile });
  stateRef.current = { content, saved, activeFile };
  const dirty = content !== saved;

  const load = useCallback(
    async (path: string) => {
      try {
        const text = await api.readFile(path);
        setContent(text);
        setSaved(text);
        setExternalChange(false);
        setError(null);
      } catch (e) {
        setError(String(e));
      }
    },
    []
  );

  useEffect(() => {
    if (!activeFile) return;
    load(activeFile);
    let alive = true;
    loadLanguage(languageFor(activeFile)).then((ext) => alive && setLangExt(ext));
    return () => {
      alive = false;
    };
  }, [activeFile, load]);

  useEffect(() => {
    const { activeFile: path } = stateRef.current;
    if (!path || changeVersion === 0) return;
    const changed = useApp.getState().changedPaths;
    const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
    if (!changed.some((c) => norm(c) === norm(path))) return;
    api
      .readFile(path)
      .then((disk) => {
        const { content: cur, saved: base } = stateRef.current;
        if (disk === base) return;
        if (cur === base) {
          setContent(disk);
          setSaved(disk);
        } else {
          setExternalChange(true);
        }
      })
      .catch(() => {});
  }, [changeVersion]);

  const save = useCallback(async () => {
    const { activeFile: path, content: cur } = stateRef.current;
    if (!path) return;
    try {
      await api.writeFile(path, cur);
      setSaved(cur);
      setExternalChange(false);
      showToast(`Saved ${path.split(/[\\/]/).pop()}`);
      bumpTree();
    } catch (e) {
      showToast(`Save failed: ${String(e)}`);
    }
  }, [bumpTree, showToast]);

  const close = async () => {
    if (dirty) {
      const ok = await confirmDialog("Discard unsaved changes?", {
        message: `${activeFile?.split(/[\\/]/).pop()} has unsaved edits.`,
        confirmLabel: "Discard",
        danger: true,
      });
      if (!ok) return;
    }
    openFile(null);
    setContent("");
    setSaved("");
  };

  const extensions = useMemo(
    () => [
      theme,
      EditorView.lineWrapping,
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            save();
            return true;
          },
        },
      ]),
      ...langExt,
    ],
    [langExt, save]
  );

  if (!activeFile) {
    return (
      <div className="grid h-full place-items-center px-6 text-center text-[12px] text-muted">
        Click a file in the left panel or a search result to open it here.
      </div>
    );
  }

  const rel = project && activeFile.startsWith(project.root) ? activeFile.slice(project.root.length).replace(/^[\\/]/, "") : activeFile;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-[#22222c] px-3 py-1.5 text-[11px] text-muted">
        <span className="min-w-0 flex-1 truncate" title={activeFile}>
          {rel}
          {dirty && <span className="ml-1 text-fuchsia2">● unsaved</span>}
        </span>
        <button className="btn btn-ghost px-1.5 py-0.5" title="Reload from disk" onClick={() => load(activeFile)}>
          <RotateCcw size={12} />
        </button>
        <button className="btn btn-primary px-2 py-0.5" disabled={!dirty} onClick={save} title="Save (Ctrl/⌘+S)">
          <Save size={12} /> Save
        </button>
        <button className="text-muted hover:text-text" onClick={close} title="Close file">
          <X size={13} />
        </button>
      </div>
      {externalChange && (
        <div className="flex items-center gap-2 border-b border-[#22222c] bg-select/40 px-3 py-1.5 text-[11.5px] text-text2">
          <span className="min-w-0 flex-1">This file changed on disk while you had unsaved edits.</span>
          <button className="btn btn-ghost px-2 py-0.5" onClick={() => load(activeFile)}>
            Load disk version
          </button>
          <button className="btn btn-ghost px-2 py-0.5" onClick={() => setExternalChange(false)}>
            Keep mine
          </button>
        </div>
      )}
      {error ? (
        <div className="grid flex-1 place-items-center px-6 text-center text-[12px] text-err">{error}</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden text-[12px]">
          <CodeMirror
            value={content}
            height="100%"
            theme="dark"
            extensions={extensions}
            basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true, bracketMatching: true, autocompletion: true }}
            onChange={(v) => setContent(v)}
          />
        </div>
      )}
    </div>
  );
}
