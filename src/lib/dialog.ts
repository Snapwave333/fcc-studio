import { create } from "zustand";

export interface DialogRequest {
  id: number;
  kind: "confirm" | "prompt";
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  danger?: boolean;
  resolve: (value: string | boolean | null) => void;
}

interface DialogState {
  queue: DialogRequest[];
  push: (req: Omit<DialogRequest, "id">) => void;
  settle: (id: number, value: string | boolean | null) => void;
}

let seq = 0;

export const useDialogs = create<DialogState>((set, get) => ({
  queue: [],
  push: (req) => set({ queue: [...get().queue, { ...req, id: ++seq }] }),
  settle: (id, value) => {
    const req = get().queue.find((r) => r.id === id);
    set({ queue: get().queue.filter((r) => r.id !== id) });
    req?.resolve(value);
  },
}));

export function confirmDialog(
  title: string,
  opts: { message?: string; confirmLabel?: string; danger?: boolean } = {}
): Promise<boolean> {
  return new Promise((resolve) => {
    useDialogs.getState().push({
      kind: "confirm",
      title,
      ...opts,
      resolve: (v) => resolve(v === true),
    });
  });
}

export function promptDialog(
  title: string,
  opts: { message?: string; defaultValue?: string; placeholder?: string; confirmLabel?: string } = {}
): Promise<string | null> {
  return new Promise((resolve) => {
    useDialogs.getState().push({
      kind: "prompt",
      title,
      ...opts,
      resolve: (v) => resolve(typeof v === "string" ? v : null),
    });
  });
}
