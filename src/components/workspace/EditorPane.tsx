import { useCallback, useEffect, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import type { Extension } from "@codemirror/state";
import { RotateCcw, Save, X } from "lucide-react";
import { useApp } from "../../store/useApp";
import { api } from "../../lib/api";

async function languageFor(path: string): Promise<Extension[]> {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
      return [(await import("@codemirror/lang-javascript")).javascript()];
    case "jsx":
      return [(await import("@codemirror/lang-javascript")).javascript({ jsx: true })];
    case "ts":
    case "mts":
    case "cts":
      return [(await import("@codemirror/lang-javascript")).javascript({ typescript: true })];
    case "tsx":
      return [(await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true })];
    case "html":
    case "htm":
    case "vue":
    case "svelte":
      return [(await import("@codemirror/lang-html")).html()];
    case "css":
    case "scss":
    case "less":
      return [(await import("@codemirror/lang-css")).css()];
    case "json":
    case "jsonc":
      return [(await import("@codemirror/lang-json")).json()];
    case "md":
    case "mdx":
    case "markdown":
      return [(await import("@codemirror/lang-markdown")).markdown()];
    case "py":
      return [(await import("@codemirror/lang-python")).python()];
    case "rs":
      return [(await import("@codemirror/lang-rust")).rust()];
    default:
      return [];
  }
}

export default function EditorPane({ active }: { active: boolean }) {
  const activeFile = useApp((s) => s.activeFile);
  const openFile = useApp((s) => s.openFile);
  const bumpTree = useApp((s) => s.bumpTree);
  const showToast = useApp((s) => s.showToast);
  const fsVersion = useApp((s) => s.fsVersion);
  const [content, setContent] = useState("");
  const [saved, setSaved] = useState("");
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [externalChange, setExternalChange] = useState(false);
  const loadedFor = useRef<string | null>(null);
  const dirty = content !== saved;

  const load = useCallback(
    async (path: string) => {
      try {
        const text = await api.readFile(path);
        loadedFor.current = path;
        setContent(text);
        setSaved(text);
        setExternalChange(false);
      } catch (e) {
        showToast(String(e));
        openFile(null);
      }
    },
    [openFile, showToast]
  );

  useEffect(() => {
    if (!activeFile) {
      loadedFor.current = null;
      setContent("");
      setSaved("");
      return;
    }
    load(activeFile);
    let cancelled = false;
    languageFor(activeFile)
      .then((ext) => !cancelled && setExtensions(ext))
      .catch(() => !cancelled && setExtensions([]));
    return () => {
      cancelled = true;
    };
  }, [activeFile, load]);

  useEffect(() => {
    if (!activeFile || loadedFor.current !== activeFile) return;
    api
      .readFile(activeFile)
      .then((text) => {
        if (text === saved) return;
        if (dirty) setExternalChange(true);
        else {
          setContent(text);
          setSaved(text);
        }
      })
      .catch(() => {});
  }, [fsVersion]);

  const save = useCallback(async () => {
    if (!activeFile) return;
    try {
      await api.writeFile(activeFile, content);
      setSaved(content);
      setExternalChange(false);
      showToast("Saved");
      bumpTree();
    } catch (e) {
      showToast(`Save failed: ${String(e)}`);
    }
  }, [activeFile, content, bumpTree, showToast]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, save]);

  if (!activeFile) {
    return (
      <div className="grid h-full place-items-center text-[12px] text-muted">Click a file in the left panel to open it.</div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-[#22222c] px-3 py-1.5 text-[11px] text-muted">
        <span className="min-w-0 flex-1 truncate" title={activeFile}>
          {dirty && <span className="mr-1 text-fuchsia2">●</span>}
          {activeFile}
        </span>
        {externalChange && (
          <button className="btn btn-ghost px-2 py-0.5 text-fuchsia2" onClick={() => load(activeFile)} title="File changed on disk — reload it">
            <RotateCcw size={12} /> reload
          </button>
        )}
        <button className="btn btn-primary px-2 py-0.5" onClick={save} disabled={!dirty} title="Save (Ctrl+S)">
          <Save size={12} /> Save
        </button>
        <button
          className="text-muted hover:text-text"
          onClick={() => {
            if (dirty && !confirm("Discard unsaved changes?")) return;
            openFile(null);
          }}
        >
          <X size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden text-[12px]">
        <CodeMirror
          value={content}
          height="100%"
          style={{ height: "100%" }}
          theme="dark"
          extensions={extensions}
          basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true }}
          onChange={setContent}
        />
      </div>
    </div>
  );
}
