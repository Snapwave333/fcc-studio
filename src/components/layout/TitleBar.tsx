import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CircleStop, ShieldAlert, ShieldCheck } from "lucide-react";
import { useApp } from "../../store/useApp";

const MODE_STYLE: Record<string, { label: string; cls: string }> = {
  normal: { label: "NORMAL", cls: "bg-elev text-text2 border border-[#2c2c38]" },
  redline: { label: "REDLINE", cls: "bg-fuchsia text-white" },
  yolo: { label: "YOLO", cls: "bg-err text-white" },
};

export default function TitleBar() {
  const win = getCurrentWindow();
  const autonomy = useApp((s) => s.autonomy);
  const isAdmin = useApp((s) => s.isAdmin);
  const setAutonomy = useApp((s) => s.setAutonomy);
  const refreshElevation = useApp((s) => s.refreshElevation);
  const emergencyStop = useApp((s) => s.emergencyStop);
  const running = useApp((s) => s.running);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    refreshElevation();
    const t = setInterval(refreshElevation, 15000);
    return () => clearInterval(t);
  }, [refreshElevation]);

  const mode = MODE_STYLE[autonomy] ?? MODE_STYLE.normal;

  return (
    <div
      data-tauri-drag-region
      className="relative flex h-9 shrink-0 items-center justify-between border-b border-[#22222c] bg-panel pl-3 select-none"
    >
      <div data-tauri-drag-region className="flex items-center gap-2">
        <img
          src="/serenity-logo-transparent.png"
          alt="Serenity"
          className="h-5 w-5 object-contain"
          data-tauri-drag-region
        />
        <span className="text-[12.5px] font-semibold tracking-wide">Serenity</span>
        <span className="chip">free-claude-code</span>

        <button
          className={`ml-2 rounded-full px-3 py-0.5 text-[11px] font-bold tracking-widest ${mode.cls}`}
          onClick={() => setPickerOpen((v) => !v)}
          title="Autonomy mode — click to change"
        >
          {mode.label}
        </button>
        {autonomy === "yolo" && <span className="animate-pulse text-[11px] text-err">●</span>}
        {isAdmin ? (
          <span className="flex items-center gap-1 text-[10.5px] font-semibold text-err" title="Process has Administrator privileges">
            <ShieldAlert size={12} /> ADMIN
          </span>
        ) : (
          <span className="flex items-center gap-1 text-[10.5px] text-muted" title="Running without Administrator privileges">
            <ShieldCheck size={12} /> user
          </span>
        )}
      </div>

      {pickerOpen && (
        <div className="absolute left-1/2 top-9 z-50 w-72 -translate-x-1/2 rounded-xl border border-[#2c2c38] bg-elev p-2 shadow-2xl">
          <p className="px-1 pb-1.5 text-[10.5px] uppercase tracking-wider text-muted">autonomy mode</p>
          {(
            [
              ["normal", "Normal", "Standard permission handling; every sensitive step asks."],
              ["redline", "Redline", "Local model only — cloud fallback removed; routine edits run without prompts."],
              ["yolo", "YOLO", "Maximum autonomy. Skip-permissions, no interruptions, admin-capable."],
            ] as [string, string, string][]
          ).map(([id, label, desc]) => (
            <button
              key={id}
              className={`block w-full rounded-lg px-2.5 py-2 text-left hover:bg-panel ${
                autonomy === id ? "bg-panel" : ""
              }`}
              onClick={async () => {
                setPickerOpen(false);
                await setAutonomy(id as any);
              }}
            >
              <div className="text-[12.5px] font-semibold">{label}</div>
              <div className="text-[11px] text-muted">{desc}</div>
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center">
        {(running || autonomy === "yolo") && (
          <button className="btn btn-danger px-3" onClick={emergencyStop} title="Kill agent run and all terminal sessions immediately">
            <CircleStop size={14} /> STOP
          </button>
        )}
        <button className="btn btn-ghost h-9 rounded-none px-4" onClick={() => win.minimize()} title="Minimize">
          &#x2013;
        </button>
        <button className="btn btn-ghost h-9 rounded-none px-4" onClick={() => win.toggleMaximize()} title="Maximize">
          &#x25A1;
        </button>
        <button
          className="btn btn-ghost h-9 rounded-none px-4 hover:bg-err hover:text-white"
          onClick={() => win.close()}
          title="Close"
        >
          &#x2715;
        </button>
      </div>
    </div>
  );
}
