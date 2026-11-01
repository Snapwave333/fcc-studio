import { useEffect, useState } from "react";
import { useApp } from "./store/useApp";
import TitleBar from "./components/layout/TitleBar";
import ThreePanel from "./components/layout/ThreePanel";
import DialogHost from "./components/common/DialogHost";
import QuickOpen from "./components/common/QuickOpen";
import { restoreZoom, zoomIn, zoomOut, zoomReset } from "./lib/zoom";

export default function App() {
  const loadProjects = useApp((s) => s.loadProjects);
  const toast = useApp((s) => s.toast);
  const [quickOpen, setQuickOpen] = useState(false);

  useEffect(() => {
    loadProjects().catch((e) => useApp.getState().showToast(`Could not load projects: ${String(e)}`));
    restoreZoom();
  }, [loadProjects]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const st = useApp.getState();
      if (e.key === "Escape" && st.running && !document.querySelector('[role="dialog"]')) {
        st.stopRun();
      } else if (mod && e.shiftKey && (e.key === "N" || e.key === "n")) {
        e.preventDefault();
        st.newSession();
      } else if (mod && !e.shiftKey && (e.key === "p" || e.key === "P")) {
        e.preventDefault();
        if (st.activeProjectId) setQuickOpen((v) => !v);
      } else if (mod && !e.altKey && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        zoomIn().then((z) => st.showToast(`Zoom ${Math.round(z * 100)}%`)).catch(() => {});
      } else if (mod && !e.altKey && e.key === "-") {
        e.preventDefault();
        zoomOut().then((z) => st.showToast(`Zoom ${Math.round(z * 100)}%`)).catch(() => {});
      } else if (mod && !e.altKey && e.key === "0") {
        e.preventDefault();
        zoomReset().then(() => st.showToast("Zoom 100%")).catch(() => {});
      } else if (mod && e.key === "`") {
        e.preventDefault();
        st.setRightTab("terminal");
      }
    };
    const block = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el?.closest("input, textarea, .cm-editor, .xterm, [data-allow-context]")) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    if (import.meta.env.PROD) window.addEventListener("contextmenu", block);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("contextmenu", block);
    };
  }, []);

  return (
    <div className="flex h-full flex-col bg-bg text-text">
      <TitleBar />
      <div className="min-h-0 flex-1">
        <ThreePanel />
      </div>
      {toast && (
        <div
          role="status"
          className="fixed bottom-4 left-1/2 z-50 max-w-[70vw] -translate-x-1/2 rounded-lg border border-[#2c2c38] bg-elev px-4 py-2 text-xs text-text shadow-xl"
          onClick={() => useApp.setState({ toast: null })}
        >
          {toast}
        </div>
      )}
      {quickOpen && <QuickOpen onClose={() => setQuickOpen(false)} />}
      <DialogHost />
    </div>
  );
}
