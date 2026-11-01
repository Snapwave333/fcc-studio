import { useEffect, useRef, useState } from "react";
import { useDialogs } from "../../lib/dialog";

export default function DialogHost() {
  const req = useDialogs((s) => s.queue[0]);
  const settle = useDialogs((s) => s.settle);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!req) return;
    setValue(req.defaultValue ?? "");
    const t = setTimeout(() => {
      if (req.kind === "prompt") {
        inputRef.current?.focus();
        inputRef.current?.select();
      } else {
        okRef.current?.focus();
      }
    }, 10);
    return () => clearTimeout(t);
  }, [req?.id]);

  if (!req) return null;

  const cancel = () => settle(req.id, req.kind === "confirm" ? false : null);
  const ok = () => {
    if (req.kind === "prompt") {
      const v = value.trim();
      settle(req.id, v ? v : null);
    } else {
      settle(req.id, true);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-black/55 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      }}
    >
      <div role="dialog" aria-modal="true" aria-label={req.title} className="w-[380px] max-w-[92vw] rounded-2xl border border-[#2c2c38] bg-elev p-4 shadow-2xl">
        <h3 className="mb-1 text-[13.5px] font-semibold text-text">{req.title}</h3>
        {req.message && <p className="mb-3 whitespace-pre-wrap text-[12px] leading-relaxed text-muted">{req.message}</p>}
        {req.kind === "prompt" && (
          <input
            ref={inputRef}
            className="input mb-3 w-full"
            value={value}
            placeholder={req.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                ok();
              }
            }}
          />
        )}
        <div className="flex justify-end gap-2">
          <button className="btn btn-ghost" onClick={cancel}>
            Cancel
          </button>
          <button
            ref={okRef}
            className={`btn ${req.danger ? "btn-danger" : "btn-primary"}`}
            onClick={ok}
            disabled={req.kind === "prompt" && !value.trim()}
          >
            {req.confirmLabel ?? (req.kind === "prompt" ? "OK" : "Confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
