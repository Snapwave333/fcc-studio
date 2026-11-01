import { useEffect } from "react";
import { useApp } from "./store/useApp";
import TitleBar from "./components/layout/TitleBar";
import ThreePanel from "./components/layout/ThreePanel";

export default function App() {
  const loadProjects = useApp((s) => s.loadProjects);
  const loadLayout = useApp((s) => s.loadLayout);
  const showToast = useApp((s) => s.showToast);
  const toast = useApp((s) => s.toast);

  useEffect(() => {
    loadLayout().catch(() => {});
    loadProjects().catch((e) => showToast(`Could not load projects: ${String(e)}`));
  }, [loadProjects, loadLayout, showToast]);

  return (
    <div className="flex h-full flex-col bg-bg text-text">
      <TitleBar />
      <div className="min-h-0 flex-1">
        <ThreePanel />
      </div>
      {toast && (
        <div
          role="status"
          className="fixed bottom-4 left-1/2 z-50 max-w-[80vw] -translate-x-1/2 rounded-lg border border-[#2c2c38] bg-elev px-4 py-2 text-xs text-text shadow-xl"
        >
          {toast}
        </div>
      )}
    </div>
  );
}
