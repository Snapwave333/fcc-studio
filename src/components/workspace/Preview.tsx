import { useCallback, useEffect, useRef, useState } from "react";
import {
  ExternalLink,
  Monitor,
  MousePointerClick,
  RefreshCw,
  Smartphone,
  Tablet,
  Play,
} from "lucide-react";
import { api, listenEvent, SelectedElement } from "../../lib/api";
import { useApp } from "../../store/useApp";

type Device = "full" | "phone" | "tablet" | "desktop";

const DEVICE_WIDTH: Record<Device, string> = {
  full: "100%",
  phone: "390px",
  tablet: "768px",
  desktop: "1280px",
};

export default function Preview() {
  const project = useApp((s) => s.activeProject());
  const setPendingElement = useApp((s) => s.setPendingElement);
  const showToast = useApp((s) => s.showToast);
  const [url, setUrl] = useState("");
  const [input, setInput] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [device, setDevice] = useState<Device>("full");
  const [key, setKey] = useState(0);
  const [internalPort, setInternalPort] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const lastSelectTs = useRef(0);
  const autoStarted = useRef(false);

  useEffect(() => {
    if (project && !autoStarted.current) {
      autoStarted.current = true;
      startInternal();
    }
  }, [project?.id]);

  useEffect(() => {
    const un = listenEvent<SelectedElement>("preview-select", (el) => {
      const now = Date.now();
      if (now - lastSelectTs.current < 300) return;
      lastSelectTs.current = now;
      setPendingElement(el);
      showToast(`Selected <${el.tag}> — describe the change you want`);
    });
    return () => {
      un.then((f) => f());
    };
  }, [setPendingElement, showToast]);

  const startInternal = useCallback(async () => {
    if (!project || loading) return;
    setLoading(true);
    try {
      const port = await api.previewStart(project.root);
      setInternalPort(port);
    } catch (e) {
      showToast(String(e));
    } finally {
      setLoading(false);
    }
  }, [project, showToast]);

  const detect = async () => {
    const open = await api.devServerScan().catch(() => []);
    if (open.length > 0) {
      setUrl(`http://127.0.0.1:${open[0].port}/`);
      showToast(`Found dev server on port ${open[0].port}`);
    } else {
      showToast("No local dev server detected — start one in the Terminal tab");
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-[#22222c] px-2 py-1.5">
        <input
          className="input min-w-0 flex-1"
          placeholder="http://localhost:5173 or use Detect / Preview buttons"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              setUrl(input.trim());
              setKey((k) => k + 1);
            }
          }}
        />
        <button className="btn btn-ghost px-1.5" title="Refresh" onClick={() => setKey((k) => k + 1)}>
          <RefreshCw size={14} />
        </button>
        <button className={`btn btn-ghost px-1.5 ${loading ? "opacity-50" : ""}`} title="Start internal preview server for project folder" onClick={startInternal} disabled={loading}>
          {loading ? <RefreshCw size={14} className="animate-spin" /> : <Play size={14} />} <span>Preview</span>
        </button>
        <button className="btn btn-ghost px-1.5" title="Detect running dev server" onClick={detect}>
          Detect
        </button>
        <button
          className={`btn px-1.5 ${selectMode ? "btn-primary" : "btn-ghost"}`}
          title="Click-to-select elements (works on internal preview)"
          onClick={() => setSelectMode((v) => !v)}
        >
          <MousePointerClick size={14} />
        </button>
        <span className="mx-1 h-5 w-px bg-[#2c2c38]" />
        {(
          [
            ["full", Monitor],
            ["desktop", Monitor],
            ["tablet", Tablet],
            ["phone", Smartphone],
          ] as [Device, any][]
        ).map(([d, Icon], i) => (
          <button
            key={d + i}
            className={`btn px-1.5 ${device === d ? "text-fuchsia2" : "btn-ghost"}`}
            onClick={() => setDevice(d)}
            title={d}
          >
            <Icon size={14} />
          </button>
        ))}
        {url && (
          <button className="btn btn-ghost px-1.5" title="Open in Chrome" onClick={() => api.openExternal(url)}>
            <ExternalLink size={14} />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-[#0c0c10] p-2">
        {internalPort ? (
          <div className="mx-auto h-full transition-all" style={{ width: DEVICE_WIDTH[device], maxWidth: "100%" }}>
            <iframe
              key={key + internalPort}
              src={`http://127.0.0.1:${internalPort}/?__select=1`}
              className="h-full min-h-full w-full rounded-lg border border-[#22222c] bg-white"
              sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
              title="Live preview"
            />
          </div>
        ) : url ? (
          <div className="mx-auto h-full transition-all" style={{ width: DEVICE_WIDTH[device], maxWidth: "100%" }}>
            <iframe
              key={key + url}
              src={url + (selectMode ? (url.includes("?") ? "&" : "?") + "__select=1" : "")}
              className="h-full min-h-full w-full rounded-lg border border-[#22222c] bg-white"
              sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
              title="Live preview"
            />
          </div>
        ) : (
          <div className="grid h-full place-items-center text-center text-[12.5px] text-muted">
            <div>
              <p className="mb-2">No preview yet.</p>
              <p>
                Click <b>Preview</b> to serve this project folder locally, or <b>Detect</b> to find a
                running dev server.
              </p>
            </div>
          </div>
        )}
      </div>
      {internalPort && (
        <div className="border-t border-[#22222c] px-3 py-1 text-[10.5px] text-muted">
          internal static server on 127.0.0.1:{internalPort} · selection overlay {selectMode ? "on" : "off"}
        </div>
      )}
    </div>
  );
}