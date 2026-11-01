import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Laptop, Monitor, MousePointerClick, Play, Radar, RefreshCw, Smartphone, Square, Tablet } from "lucide-react";
import { api, listenEvent, SelectedElement } from "../../lib/api";
import { useApp } from "../../store/useApp";

type Device = "full" | "desktop" | "tablet" | "phone";
type Source = { kind: "internal"; port: number } | { kind: "url"; url: string } | null;

const DEVICE_WIDTH: Record<Device, string> = {
  full: "100%",
  desktop: "1280px",
  tablet: "768px",
  phone: "390px",
};

export function normalizeUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (/^\d{2,5}$/.test(v)) return `http://127.0.0.1:${v}/`;
  const withScheme = /^https?:\/\//i.test(v) ? v : `http://${v}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

export default function Preview() {
  const project = useApp((s) => s.activeProject());
  const updateProject = useApp((s) => s.updateProject);
  const setPendingElement = useApp((s) => s.setPendingElement);
  const showToast = useApp((s) => s.showToast);
  const changeVersion = useApp((s) => s.changeVersion);
  const [source, setSource] = useState<Source>(null);
  const [input, setInput] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [device, setDevice] = useState<Device>("full");
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [autoReload, setAutoReload] = useState(true);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const lastSelectTs = useRef(0);
  const selectModeRef = useRef(selectMode);
  selectModeRef.current = selectMode;

  const src =
    source?.kind === "internal"
      ? `http://127.0.0.1:${source.port}/`
      : source?.kind === "url"
      ? source.url
      : "";

  const startInternal = useCallback(async () => {
    const p = useApp.getState().activeProject();
    if (!p) return;
    setLoading(true);
    try {
      const port = await api.previewStart(p.root);
      setSource({ kind: "internal", port });
      setInput(`http://127.0.0.1:${port}/`);
      setReloadKey((k) => k + 1);
    } catch (e) {
      showToast(String(e));
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    setSelectMode(false);
    if (!project) {
      setSource(null);
      setInput("");
      api.previewStop().catch(() => {});
      return;
    }
    const saved = normalizeUrl(project.preview_url ?? "");
    if (saved) {
      setSource({ kind: "url", url: saved });
      setInput(saved);
    } else {
      startInternal();
    }
  }, [project?.id]);

  const accept = useCallback(
    (el: SelectedElement) => {
      const now = Date.now();
      if (now - lastSelectTs.current < 300) return;
      lastSelectTs.current = now;
      setPendingElement(el);
      showToast(`Selected <${el.tag}> — describe the change you want`);
    },
    [setPendingElement, showToast]
  );

  useEffect(() => {
    const un = listenEvent<SelectedElement>("preview-select", accept);
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frameRef.current?.contentWindow) return;
      if (e.data?.type === "serenity:selected" && e.data.element) accept(e.data.element);
    };
    window.addEventListener("message", onMsg);
    return () => {
      un.then((f) => f());
      window.removeEventListener("message", onMsg);
    };
  }, [accept]);

  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage({ type: "serenity:select", on: selectMode }, "*");
  }, [selectMode]);

  useEffect(() => {
    if (!autoReload || source?.kind !== "internal" || changeVersion === 0) return;
    const t = setTimeout(() => setReloadKey((k) => k + 1), 150);
    return () => clearTimeout(t);
  }, [changeVersion, autoReload, source?.kind]);

  const go = (raw: string) => {
    const url = normalizeUrl(raw);
    if (!url) {
      showToast("Enter a valid http(s) URL or port number");
      return;
    }
    setSource({ kind: "url", url });
    setInput(url);
    setReloadKey((k) => k + 1);
    if (project) updateProject(project.id, { preview_url: url }).catch(() => {});
  };

  const useInternal = () => {
    if (project?.preview_url) updateProject(project.id, { preview_url: "" }).catch(() => {});
    startInternal();
  };

  const detect = async () => {
    const open = await api.devServerScan().catch(() => []);
    if (open.length > 0) {
      const best = open[0];
      go(`http://127.0.0.1:${best.port}/`);
      showToast(
        `Found ${open.length} dev server${open.length > 1 ? "s" : ""}: ${open
          .map((o) => `:${o.port}${o.title ? ` (${o.title})` : ""}`)
          .join(", ")}`
      );
    } else {
      showToast("No local dev server detected — start one in the Terminal tab");
    }
  };

  const stop = async () => {
    await api.previewStop().catch(() => {});
    setSource(null);
    setSelectMode(false);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-[#22222c] px-2 py-1.5">
        <input
          className="input min-w-0 flex-1"
          placeholder="URL or port (e.g. 5173), Enter to load"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") go(input);
          }}
        />
        <button className="btn btn-ghost px-1.5" title="Reload" onClick={() => setReloadKey((k) => k + 1)} disabled={!source}>
          <RefreshCw size={14} />
        </button>
        <button
          className={`btn px-1.5 ${source?.kind === "internal" ? "text-fuchsia2" : "btn-ghost"}`}
          title="Serve this project folder with the built-in static server"
          onClick={useInternal}
          disabled={loading || !project}
        >
          {loading ? <RefreshCw size={14} className="animate-spin" /> : <Play size={14} />}
        </button>
        <button className="btn btn-ghost px-1.5" title="Detect a running dev server" onClick={detect}>
          <Radar size={14} />
        </button>
        <button
          className={`btn px-1.5 ${selectMode ? "btn-primary" : "btn-ghost"}`}
          title={
            source?.kind === "internal"
              ? "Click-to-select an element and send it to the agent"
              : "Element selection works with the built-in server (Play button)"
          }
          onClick={() => setSelectMode((v) => !v)}
          disabled={source?.kind !== "internal"}
        >
          <MousePointerClick size={14} />
        </button>
        <span className="mx-0.5 h-5 w-px bg-[#2c2c38]" />
        {(
          [
            ["full", Monitor, "Fit panel"],
            ["desktop", Laptop, "Desktop 1280px"],
            ["tablet", Tablet, "Tablet 768px"],
            ["phone", Smartphone, "Phone 390px"],
          ] as [Device, any, string][]
        ).map(([d, Icon, title]) => (
          <button key={d} className={`btn px-1.5 ${device === d ? "text-fuchsia2" : "btn-ghost"}`} onClick={() => setDevice(d)} title={title}>
            <Icon size={14} />
          </button>
        ))}
        {src && (
          <button className="btn btn-ghost px-1.5" title="Open in browser" onClick={() => api.openExternal(src).catch((e) => showToast(String(e)))}>
            <ExternalLink size={14} />
          </button>
        )}
        {source && (
          <button className="btn btn-ghost px-1.5" title="Stop preview" onClick={stop}>
            <Square size={13} />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-[#0c0c10] p-2">
        {source ? (
          <div className="mx-auto h-full transition-all" style={{ width: DEVICE_WIDTH[device], maxWidth: device === "full" ? "100%" : undefined }}>
            <iframe
              ref={frameRef}
              key={`${reloadKey}-${src}`}
              src={src}
              className="h-full min-h-full w-full rounded-lg border border-[#22222c] bg-white"
              sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"
              title="Live preview"
              onLoad={() => frameRef.current?.contentWindow?.postMessage({ type: "serenity:select", on: selectModeRef.current }, "*")}
            />
          </div>
        ) : (
          <div className="grid h-full place-items-center text-center text-[12.5px] text-muted">
            <div className="max-w-xs space-y-3">
              <p>No preview running.</p>
              <div className="flex justify-center gap-2">
                <button className="btn btn-primary" onClick={useInternal} disabled={!project}>
                  <Play size={13} /> Serve folder
                </button>
                <button className="btn btn-ghost" onClick={detect}>
                  <Radar size={13} /> Detect dev server
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-[#22222c] px-3 py-1 text-[10.5px] text-muted">
        <span className="min-w-0 flex-1 truncate">
          {source?.kind === "internal"
            ? `built-in server · 127.0.0.1:${source.port} · select ${selectMode ? "on" : "off"}`
            : source?.kind === "url"
            ? `external · ${source.url}`
            : project?.root ?? ""}
        </span>
        {source?.kind === "internal" && (
          <label className="flex cursor-pointer items-center gap-1">
            <input type="checkbox" className="accent-fuchsia" checked={autoReload} onChange={(e) => setAutoReload(e.target.checked)} />
            reload on save
          </label>
        )}
      </div>
    </div>
  );
}
