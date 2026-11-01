import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Maximize2, Monitor, MousePointerClick, Play, RefreshCw, Smartphone, Tablet } from "lucide-react";
import { api, listenEvent, SelectedElement } from "../../lib/api";
import { useApp } from "../../store/useApp";

type Device = "full" | "phone" | "tablet" | "desktop";

const DEVICE_WIDTH: Record<Device, string> = {
  full: "100%",
  phone: "390px",
  tablet: "768px",
  desktop: "1280px",
};

const DEVICES: [Device, typeof Monitor, string][] = [
  ["full", Maximize2, "Fill panel"],
  ["desktop", Monitor, "Desktop 1280px"],
  ["tablet", Tablet, "Tablet 768px"],
  ["phone", Smartphone, "Phone 390px"],
];

export default function Preview() {
  const project = useApp((s) => s.activeProject());
  const setPendingElement = useApp((s) => s.setPendingElement);
  const showToast = useApp((s) => s.showToast);
  const fsVersion = useApp((s) => s.fsVersion);
  const patchProject = useApp((s) => s.patchProject);
  const [externalUrl, setExternalUrl] = useState("");
  const [input, setInput] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [device, setDevice] = useState<Device>("full");
  const [reloadKey, setReloadKey] = useState(0);
  const [internalPort, setInternalPort] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [detected, setDetected] = useState<number[]>([]);
  const [autoReload, setAutoReload] = useState(true);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const lastSelectTs = useRef(0);

  const usingInternal = !externalUrl && internalPort !== null;
  const src = externalUrl || (internalPort ? `http://127.0.0.1:${internalPort}/` : "");

  const startInternal = useCallback(async () => {
    if (!project) return;
    setLoading(true);
    try {
      setInternalPort(await api.previewStart(project.root));
    } catch (e) {
      setInternalPort(null);
      showToast(String(e));
    } finally {
      setLoading(false);
    }
  }, [project?.root, showToast]);

  useEffect(() => {
    setSelectMode(false);
    setDetected([]);
    const saved = project?.preview_url ?? "";
    setExternalUrl(saved);
    setInput(saved);
    if (project) startInternal();
    else setInternalPort(null);
  }, [project?.id]);

  useEffect(() => {
    if (autoReload && usingInternal) setReloadKey((k) => k + 1);
  }, [fsVersion]);

  useEffect(() => {
    const un = listenEvent<SelectedElement>("preview-select", (el) => {
      const now = Date.now();
      if (now - lastSelectTs.current < 300) return;
      lastSelectTs.current = now;
      setPendingElement(el);
      setSelectMode(false);
      showToast(`Selected <${el.tag}> — describe the change you want`);
    });
    return () => {
      un.then((f) => f());
    };
  }, [setPendingElement, showToast]);

  const postSelectMode = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage({ __fccSelect: selectMode }, "*");
  }, [selectMode]);

  useEffect(postSelectMode, [postSelectMode]);

  const navigate = (raw: string) => {
    let url = raw.trim();
    if (url && !/^https?:\/\//i.test(url)) url = `http://${url}`;
    setExternalUrl(url);
    setInput(url);
    setReloadKey((k) => k + 1);
    if (project && project.preview_url !== url) patchProject(project.id, { preview_url: url }).catch(() => {});
  };

  const detect = async () => {
    const open = (await api.devServerScan().catch(() => [])).map((p) => p.port);
    setDetected(open);
    if (open.length > 0) {
      navigate(`http://127.0.0.1:${open[0]}/`);
      showToast(open.length > 1 ? `Found dev servers on ${open.join(", ")}` : `Found dev server on port ${open[0]}`);
    } else {
      showToast("No local dev server detected — start one in the Terminal tab");
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-[#22222c] px-2 py-1.5">
        <input
          className="input min-w-0 flex-1"
          placeholder={usingInternal ? `static server · 127.0.0.1:${internalPort}` : "http://localhost:5173"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") navigate(input);
          }}
        />
        <button className="btn btn-ghost px-1.5" title="Reload" onClick={() => setReloadKey((k) => k + 1)}>
          <RefreshCw size={14} />
        </button>
        <button
          className={`btn px-1.5 ${usingInternal ? "text-fuchsia2" : "btn-ghost"}`}
          title="Serve the project folder with the built-in static server"
          onClick={() => {
            navigate("");
            startInternal();
          }}
          disabled={loading || !project}
        >
          {loading ? <RefreshCw size={14} className="animate-spin" /> : <Play size={14} />}
        </button>
        <button className="btn btn-ghost px-1.5" title="Detect running dev servers" onClick={detect}>
          Detect
        </button>
        <button
          className={`btn px-1.5 ${selectMode ? "btn-primary" : "btn-ghost"}`}
          title={usingInternal ? "Click an element to attach it to your next prompt" : "Element selection works with the built-in static server"}
          onClick={() => setSelectMode((v) => !v)}
          disabled={!usingInternal}
        >
          <MousePointerClick size={14} />
        </button>
        <span className="mx-1 h-5 w-px bg-[#2c2c38]" />
        {DEVICES.map(([d, Icon, label]) => (
          <button key={d} className={`btn px-1.5 ${device === d ? "text-fuchsia2" : "btn-ghost"}`} onClick={() => setDevice(d)} title={label}>
            <Icon size={14} />
          </button>
        ))}
        {src && (
          <button className="btn btn-ghost px-1.5" title="Open in browser" onClick={() => api.openExternal(src).catch((e) => showToast(String(e)))}>
            <ExternalLink size={14} />
          </button>
        )}
      </div>

      {detected.length > 1 && (
        <div className="flex items-center gap-1 border-b border-[#22222c] px-2 py-1 text-[11px] text-muted">
          dev servers:
          {detected.map((p) => (
            <button key={p} className="chip hover:text-text" onClick={() => navigate(`http://127.0.0.1:${p}/`)}>
              :{p}
            </button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto bg-[#0c0c10] p-2">
        {src ? (
          <div className="mx-auto h-full transition-all" style={{ width: DEVICE_WIDTH[device], maxWidth: "100%" }}>
            <iframe
              ref={frameRef}
              key={`${src}#${reloadKey}`}
              src={src}
              onLoad={postSelectMode}
              className="h-full min-h-full w-full rounded-lg border border-[#22222c] bg-white"
              sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"
              title="Live preview"
            />
          </div>
        ) : (
          <div className="grid h-full place-items-center text-center text-[12.5px] text-muted">
            <div>
              <p className="mb-2">No preview yet.</p>
              <p>
                Click <b>▶</b> to serve this project folder locally, or <b>Detect</b> to find a running dev server.
              </p>
            </div>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-[#22222c] px-3 py-1 text-[10.5px] text-muted">
        <span className="min-w-0 flex-1 truncate">
          {usingInternal
            ? `static server 127.0.0.1:${internalPort} · selection ${selectMode ? "on — click an element" : "off"}`
            : externalUrl
            ? `external · ${externalUrl}`
            : "idle"}
        </span>
        {usingInternal && (
          <label className="flex cursor-pointer items-center gap-1">
            <input type="checkbox" checked={autoReload} onChange={(e) => setAutoReload(e.target.checked)} className="accent-fuchsia-500" />
            reload on change
          </label>
        )}
      </div>
    </div>
  );
}
