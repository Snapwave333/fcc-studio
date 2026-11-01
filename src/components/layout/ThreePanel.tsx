import { useCallback, useEffect, useRef, useState } from "react";
import LeftPanel from "../nav/LeftPanel";
import AgentPanel from "../agent/AgentPanel";
import RightPanel from "../workspace/RightPanel";
import { api } from "../../lib/api";
import { RightTab, useApp } from "../../store/useApp";

export interface Layout {
  leftW: number;
  rightW: number;
  leftOpen: boolean;
  rightOpen: boolean;
  rightTab: RightTab;
}

const DEFAULT_LAYOUT: Layout = { leftW: 268, rightW: 480, leftOpen: true, rightOpen: true, rightTab: "preview" };
const TABS: RightTab[] = ["preview", "terminal", "git", "editor", "skills", "memory", "redline", "env"];

export function sanitizeLayout(raw: unknown): Layout {
  const v = (raw && typeof raw === "object" ? raw : {}) as Partial<Layout>;
  const num = (x: unknown, lo: number, hi: number, d: number) =>
    typeof x === "number" && Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : d;
  return {
    leftW: num(v.leftW, 180, 460, DEFAULT_LAYOUT.leftW),
    rightW: num(v.rightW, 300, 1100, DEFAULT_LAYOUT.rightW),
    leftOpen: typeof v.leftOpen === "boolean" ? v.leftOpen : true,
    rightOpen: typeof v.rightOpen === "boolean" ? v.rightOpen : true,
    rightTab: TABS.includes(v.rightTab as RightTab) ? (v.rightTab as RightTab) : "preview",
  };
}

function Resizer({ onDelta, onDone, label }: { onDelta: (dx: number) => void; onDone: () => void; label: string }) {
  const last = useRef(0);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => {
      const dx = e.clientX - last.current;
      last.current = e.clientX;
      onDelta(dx);
    };
    const up = () => {
      setDragging(false);
      onDone();
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [dragging, onDelta, onDone]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      onMouseDown={(e) => {
        last.current = e.clientX;
        setDragging(true);
        e.preventDefault();
      }}
      className={`relative z-10 -mx-[2px] w-[5px] shrink-0 cursor-col-resize transition-colors hover:bg-fuchsia/50 ${
        dragging ? "bg-fuchsia/60" : "bg-transparent"
      }`}
    >
      {dragging && <div className="fixed inset-0 z-50 cursor-col-resize" />}
    </div>
  );
}

export default function ThreePanel() {
  const [layout, setLayout] = useState<Layout>(DEFAULT_LAYOUT);
  const [loaded, setLoaded] = useState(false);
  const rightTab = useApp((s) => s.rightTab);
  const setRightTab = useApp((s) => s.setRightTab);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  useEffect(() => {
    api
      .kvGet("layout")
      .then((raw) => {
        if (raw) {
          const parsed = sanitizeLayout(JSON.parse(raw));
          setLayout(parsed);
          setRightTab(parsed.rightTab);
        }
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [setRightTab]);

  const persist = useCallback(() => {
    api.kvSet("layout", JSON.stringify({ ...layoutRef.current, rightTab: useApp.getState().rightTab })).catch(() => {});
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(persist, 400);
    return () => clearTimeout(t);
  }, [layout.leftOpen, layout.rightOpen, rightTab, loaded, persist]);

  useEffect(() => {
    const onResize = () => {
      const avail = window.innerWidth - 360;
      setLayout((l) => {
        const total = (l.leftOpen ? l.leftW : 0) + (l.rightOpen ? l.rightW : 0);
        if (total <= avail || total === 0) return l;
        const ratio = avail / total;
        return {
          ...l,
          leftW: Math.max(180, Math.round(l.leftW * ratio)),
          rightW: Math.max(300, Math.round(l.rightW * ratio)),
        };
      });
    };
    window.addEventListener("resize", onResize);
    onResize();
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const nudgeLeft = useCallback((dx: number) => setLayout((l) => ({ ...l, leftW: Math.min(460, Math.max(180, l.leftW + dx)) })), []);
  const nudgeRight = useCallback(
    (dx: number) => setLayout((l) => ({ ...l, rightW: Math.min(Math.max(300, window.innerWidth - 520), Math.max(300, l.rightW - dx)) })),
    []
  );

  return (
    <div className="flex h-full w-full">
      {layout.leftOpen && (
        <>
          <div className="min-w-0 shrink-0" style={{ width: layout.leftW }}>
            <LeftPanel width={layout.leftW} onToggle={() => setLayout((l) => ({ ...l, leftOpen: false }))} />
          </div>
          <Resizer label="Resize file panel" onDelta={nudgeLeft} onDone={persist} />
        </>
      )}
      <div className="min-w-0 flex-1">
        <AgentPanel
          leftOpen={layout.leftOpen}
          rightOpen={layout.rightOpen}
          onToggleLeft={() => setLayout((l) => ({ ...l, leftOpen: !l.leftOpen }))}
          onToggleRight={() => setLayout((l) => ({ ...l, rightOpen: !l.rightOpen }))}
        />
      </div>
      {layout.rightOpen && (
        <>
          <Resizer label="Resize workspace panel" onDelta={nudgeRight} onDone={persist} />
          <div className="min-w-0 shrink-0" style={{ width: layout.rightW }}>
            <RightPanel onToggle={() => setLayout((l) => ({ ...l, rightOpen: false }))} />
          </div>
        </>
      )}
    </div>
  );
}
