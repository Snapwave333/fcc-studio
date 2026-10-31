import { useEffect } from "react";
import { useApp } from "./store/useApp";
import TitleBar from "./components/layout/TitleBar";
import ThreePanel from "./components/layout/ThreePanel";

export default function App() {
  const loadProjects = useApp((s) => s.loadProjects);
  const toast = useApp((s) => s.toast);

  useEffect(() => {
    loadProjects().catch((e) => console.error("loadProjects", e));
  }, [loadProjects]);

  return (
    <div className="flex h-full flex-col bg-bg text-text">
      <TitleBar />
      <div className="min-h-0 flex-1">
        <ThreePanel />
      </div>
      {toast && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-elev px-4 py-2 text-xs text-text shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
