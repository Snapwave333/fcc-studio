import { useEffect, useRef, useState } from "react";
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
      dragging.current = false;
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
  const [leftW, setLeftW] = useState(268);
  const [rightW, setRightW] = useState(480);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  const nudgeLeft = (dx: number) => setLeftW((w) => Math.min(460, Math.max(180, w + dx)));
  const nudgeRight = (dx: number) => setRightW((w) => Math.min(900, Math.max(300, w + dx)));

  return (
    <div className="flex h-full w-full">
      {leftOpen && (
        <div className="order-0 min-w-0 shrink-0" style={{ width: leftW }}>
          <LeftPanel width={leftW} onToggle={() => setLeftOpen(false)} />
        </div>
      )}
      <Resizer side="left" onDelta={nudgeLeft} />
      <div className="order-2 min-w-0 flex-1">
        <AgentPanel
          leftOpen={leftOpen}
          rightOpen={rightOpen}
          onToggleLeft={() => setLeftOpen((v) => !v)}
          onToggleRight={() => setRightOpen((v) => !v)}
        />
      </div>
      <Resizer side="right" onDelta={nudgeRight} />
      {rightOpen && (
        <div className="order-5 min-w-0 shrink-0" style={{ width: rightW }}>
          <RightPanel width={rightW} onToggle={() => setRightOpen(false)} />
        </div>
      )}
    </div>
  );
}
