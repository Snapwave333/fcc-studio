import { useEffect, useRef } from "react";
import { useApp } from "../../store/useApp";
import LeftPanel from "../nav/LeftPanel";
import AgentPanel from "../agent/AgentPanel";
import RightPanel from "../workspace/RightPanel";

function Resizer({
  side,
  onDelta,
}: {
  side: "left" | "right";
  onDelta: (dx: number) => void;
}) {
  const dragging = useRef(false);
  const last = useRef(0);

  const onMouseDown = (e: React.MouseEvent) => {
    dragging.current = true;
    last.current = e.clientX;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  };

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - last.current;
      last.current = e.clientX;
      onDelta(side === "left" ? dx : -dx);
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [onDelta, side]);

  return (
    <div
      onMouseDown={onMouseDown}
      className={`w-[3px] shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-fuchsia/60 ${
        side === "left" ? "order-1" : "order-4"
      }`}
    />
  );
}

export default function ThreePanel() {
  const layout = useApp((s) => s.layout);
  const updateLayout = useApp((s) => s.updateLayout);
  const { leftW, rightW, leftOpen, rightOpen } = layout;

  const nudgeLeft = (dx: number) => {
    const w = useApp.getState().layout.leftW;
    updateLayout({ leftW: Math.min(460, Math.max(180, w + dx)) });
  };
  const nudgeRight = (dx: number) => {
    const w = useApp.getState().layout.rightW;
    updateLayout({ rightW: Math.min(1100, Math.max(300, w + dx)) });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === "b") {
        e.preventDefault();
        updateLayout({ leftOpen: !useApp.getState().layout.leftOpen });
      } else if (e.key.toLowerCase() === "j") {
        e.preventDefault();
        updateLayout({ rightOpen: !useApp.getState().layout.rightOpen });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [updateLayout]);

  return (
    <div className="flex h-full w-full">
      {leftOpen && (
        <div className="order-0 min-w-0 shrink-0" style={{ width: leftW }}>
          <LeftPanel width={leftW} onToggle={() => updateLayout({ leftOpen: false })} />
        </div>
      )}
      {leftOpen && <Resizer side="left" onDelta={nudgeLeft} />}
      <div className="order-2 min-w-0 flex-1">
        <AgentPanel
          leftOpen={leftOpen}
          rightOpen={rightOpen}
          onToggleLeft={() => updateLayout({ leftOpen: !leftOpen })}
          onToggleRight={() => updateLayout({ rightOpen: !rightOpen })}
        />
      </div>
      {rightOpen && <Resizer side="right" onDelta={nudgeRight} />}
      <div className="order-5 min-w-0 shrink-0" style={{ width: rightW, display: rightOpen ? undefined : "none" }}>
        <RightPanel width={rightW} onToggle={() => updateLayout({ rightOpen: false })} />
      </div>
    </div>
  );
}
