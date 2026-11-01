import { create } from "zustand";
import { api, listenEvent, Project, SelectedElement, StoredMessage } from "../lib/api";
import {
  AgentEventState,
  ChatMessage,
  ToolActivity,
  emptyAgentEventState,
  processAgentEvent,
} from "../lib/agent-events";
import { confirmDialog } from "../lib/dialog";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";

export type { ChatMessage, ToolActivity } from "../lib/agent-events";

export type Autonomy = "normal" | "redline" | "yolo";

export type RightTab = "preview" | "terminal" | "git" | "editor" | "skills" | "memory" | "redline" | "env";

export interface ThreadSummary {
  id: string;
  title: string;
  updated: number;
  count: number;
}

interface AppState {
  projects: Project[];
  activeProjectId: string | null;
  sessionId: string;
  threadId: string;
  threads: ThreadSummary[];
  messages: ChatMessage[];
  running: boolean;
  runId: string | null;
  activityLog: string[];
  inspectorOpen: boolean;
  pendingElement: SelectedElement | null;
  activeFile: string | null;
  fileTreeVersion: number;
  changedPaths: string[];
  changeVersion: number;
  toast: string | null;
  autonomy: Autonomy;
  isAdmin: boolean;
  pendingSkill: string | null;
  rightTab: RightTab;
  ev: AgentEventState;
  model: string;
  setModel: (model: string) => Promise<void>;

  setAutonomy: (level: Autonomy) => Promise<boolean>;
  activateRedline: (model: string) => Promise<boolean>;
  deactivateRedline: () => Promise<void>;
  setPendingSkill: (name: string | null) => void;
  refreshElevation: () => Promise<void>;
  emergencyStop: () => Promise<void>;
  loadProjects: () => Promise<void>;
  updateProject: (id: string, patch: Partial<Pick<Project, "name" | "instructions" | "preview_url" | "layout">>) => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  setActiveProject: (id: string | null) => Promise<void>;
  activeProject: () => Project | null;
  sendMessage: (text: string) => Promise<void>;
  stopRun: () => Promise<void>;
  newSession: () => void;
  openThread: (threadId: string, preloaded?: StoredMessage[]) => Promise<void>;
  setPendingElement: (el: SelectedElement | null) => void;
  setInspectorOpen: (open: boolean) => void;
  openFile: (path: string | null) => void;
  setRightTab: (tab: RightTab) => void;
  bumpTree: () => void;
  showToast: (msg: string) => void;
}

const LEGACY_THREAD = "legacy";

function parseMeta(raw: string): Record<string, any> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function storedToChat(m: StoredMessage): ChatMessage {
  let text = m.content;
  let tools: ToolActivity[] = [];
  let meta: string | undefined;
  let error = false;
  let parts: ChatMessage["parts"];
  if (m.role === "assistant") {
    try {
      const parsed = JSON.parse(m.content);
      text = parsed.text ?? "";
      tools = Array.isArray(parsed.tools) ? parsed.tools : [];
      meta = parsed.meta || undefined;
      error = !!parsed.error;
      parts = Array.isArray(parsed.parts) && parsed.parts.length ? parsed.parts : undefined;
    } catch {
      text = m.content;
    }
  }
  const ts = new Date(m.created_at).getTime();
  return {
    id: m.id,
    role: (m.role as ChatMessage["role"]) ?? "assistant",
    text,
    tools,
    streaming: false,
    ts: Number.isFinite(ts) ? ts : Date.now(),
    meta,
    error,
    parts,
  };
}

export function threadOf(m: StoredMessage): string {
  return parseMeta(m.meta).thread || LEGACY_THREAD;
}

export function summarizeThreads(stored: StoredMessage[]): ThreadSummary[] {
  const map = new Map<string, ThreadSummary>();
  for (const m of stored) {
    const id = threadOf(m);
    const ts = new Date(m.created_at).getTime() || 0;
    const cur = map.get(id) ?? { id, title: "", updated: 0, count: 0 };
    cur.count++;
    cur.updated = Math.max(cur.updated, ts);
    if (!cur.title && m.role === "user") cur.title = m.content.replace(/\s+/g, " ").slice(0, 80);
    map.set(id, cur);
  }
  return [...map.values()]
    .map((t) => ({ ...t, title: t.title || (t.id === LEGACY_THREAD ? "Earlier conversation" : "Conversation") }))
    .sort((a, b) => b.updated - a.updated);
}

let eventsBound = false;
const deadRuns = new Set<string>();
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function acceptsRun(s: AppState, runId: string): boolean {
  if (!s.running || deadRuns.has(runId)) return false;
  return s.runId === null || s.runId === runId;
}

function notifyIfBackground(msg: ChatMessage | undefined) {
  if (typeof document === "undefined" || document.hasFocus()) return;
  try {
    const win = getCurrentWindow();
    win.requestUserAttention(UserAttentionType.Informational).catch(() => {});
    const base = "Serenity";
    document.title = `${msg?.error ? "⚠" : "✓"} ${base}`;
    const restore = () => {
      document.title = base;
      window.removeEventListener("focus", restore);
    };
    window.addEventListener("focus", restore);
  } catch {
    return;
  }
}

function persistAssistant(get: () => AppState, msg: ChatMessage | undefined) {
  const projectId = get().activeProjectId;
  if (!projectId || !msg || msg.role !== "assistant") return;
  if (!msg.text && msg.tools.length === 0) return;
  api
    .addMessage(
      projectId,
      get().sessionId,
      "assistant",
      JSON.stringify({ text: msg.text, tools: msg.tools, parts: msg.parts ?? [], meta: msg.meta ?? "", error: !!msg.error }),
      JSON.stringify({ thread: get().threadId })
    )
    .catch(() => {});
}

async function bindEvents(set: (p: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void, get: () => AppState) {
  if (eventsBound) return;
  eventsBound = true;

  await listenEvent<{ runId: string; event: any }>("agent-event", ({ runId, event }) => {
    const s = get();
    if (!acceptsRun(s, runId)) return;
    const next = processAgentEvent(s.ev, event, s.messages);
    const patch: Partial<AppState> = { messages: next.messages, ev: next.evState };
    if (s.runId === null) patch.runId = runId;
    if (next.evState.sessionId && next.evState.sessionId !== s.sessionId) patch.sessionId = next.evState.sessionId;
    if (next.finished) {
      patch.running = false;
      patch.runId = null;
    }
    set(patch);
    if (next.finished) {
      persistAssistant(get, next.messages[next.messages.length - 1]);
      notifyIfBackground(next.messages[next.messages.length - 1]);
      get().bumpTree();
    }
  });

  await listenEvent<{ runId: string; text: string }>("agent-stderr", ({ runId, text }) => {
    const s = get();
    if (s.runId !== null && s.runId !== runId) return;
    set({ activityLog: [...s.activityLog.slice(-300), `[stderr] ${text}`] });
  });

  await listenEvent<{ runId: string; code: number }>("agent-exit", ({ runId, code }) => {
    const s = get();
    const log = [...s.activityLog, `[exit] agent process exited with code ${code}`].slice(-300);
    if (!acceptsRun(s, runId)) {
      set({ activityLog: log });
      return;
    }
    const lastIdx = s.messages.length - 1;
    const last = s.messages[lastIdx];
    let messages = s.messages;
    if (last && last.streaming) {
      const stderrTail = s.activityLog
        .filter((l) => l.startsWith("[stderr]"))
        .slice(-4)
        .map((l) => l.slice(9))
        .join("\n");
      const text =
        last.text ||
        (code === 0 ? "" : `⚠ The agent exited with code ${code} before replying.${stderrTail ? `\n\n\`\`\`\n${stderrTail}\n\`\`\`` : ""}`);
      const finalMsg: ChatMessage = { ...last, text, streaming: false, thinking: false, error: code !== 0 && !last.text };
      messages = [...s.messages.slice(0, lastIdx), finalMsg];
      persistAssistant(get, finalMsg);
    }
    set({ running: false, runId: null, messages, activityLog: log, ev: { ...s.ev, committed: "", partial: "", segments: [] } });
  });

  await listenEvent<{ root: string; paths: string[] }>("fs-changed", ({ root, paths }) => {
    const p = get().activeProject();
    if (!p || p.root !== root) return;
    set((st) => ({
      fileTreeVersion: st.fileTreeVersion + 1,
      changedPaths: paths ?? [],
      changeVersion: st.changeVersion + 1,
    }));
  });
}

export const useApp = create<AppState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  sessionId: "",
  threadId: crypto.randomUUID(),
  threads: [],
  messages: [],
  running: false,
  runId: null,
  activityLog: [],
  inspectorOpen: true,
  pendingElement: null,
  activeFile: null,
  fileTreeVersion: 0,
  changedPaths: [],
  changeVersion: 0,
  toast: null,
  autonomy: "normal",
  isAdmin: false,
  pendingSkill: null,
  rightTab: "preview",
  ev: emptyAgentEventState(),
  model: "",

  setModel: async (model) => {
    const value = model.trim();
    set({ model: value });
    const id = get().activeProjectId;
    await api.kvSet(id ? `model.${id}` : "model.default", value).catch(() => {});
  },

  setAutonomy: async (level) => {
    const prev = get().autonomy;
    if (level === prev) return true;
    if (level === "yolo") {
      const ok = await confirmDialog("Enable YOLO mode?", {
        message:
          "The agent gains maximum autonomy: no permission prompts, skip-permissions enabled, and commands run without individual approval.",
        confirmLabel: "Enable YOLO",
        danger: true,
      });
      if (!ok) return false;
    }
    try {
      if (level === "redline") {
        const model = await api.kvGet("redline.model");
        if (!model) {
          get().showToast("Pick a local model in the Redline tab first");
          get().setRightTab("redline");
          return false;
        }
        await api.redlineActivate(model);
      } else if (prev === "redline") {
        await api.redlineDeactivate();
      }
    } catch (e) {
      get().showToast(String(e));
      return false;
    }
    set({ autonomy: level });
    await api.kvSet("autonomy.level", level).catch(() => {});
    api.auditWrite(`mode:${level}`, `mode changed ${prev} -> ${level}`).catch(() => {});
    return true;
  },

  activateRedline: async (model) => {
    await api.kvSet("redline.model", model).catch(() => {});
    if (get().autonomy === "redline") {
      try {
        await api.redlineActivate(model);
        return true;
      } catch (e) {
        get().showToast(String(e));
        return false;
      }
    }
    return get().setAutonomy("redline");
  },

  deactivateRedline: async () => {
    if (get().autonomy === "redline") {
      await get().setAutonomy("normal");
    } else {
      await api.redlineDeactivate().catch((e) => get().showToast(String(e)));
    }
  },

  refreshElevation: async () => {
    const st = await api.elevationStatus().catch(() => null);
    set({ isAdmin: st?.is_admin ?? false });
    const level = await api.kvGet("autonomy.level").catch(() => null);
    if (level === "normal" || level === "redline" || level === "yolo") {
      if (level !== get().autonomy) set({ autonomy: level });
    }
  },

  emergencyStop: async () => {
    const runId = get().runId;
    if (runId) deadRuns.add(runId);
    if (runId) await api.cancelAgentRun(runId).catch(() => {});
    await api.ptyKillAll().catch(() => {});
    await api.auditWrite("emergency_stop", "emergency stop: agent run and all terminal sessions terminated").catch(() => {});
    const msgs = get().messages.map((m) => (m.streaming ? { ...m, streaming: false, thinking: false } : m));
    set({
      running: false,
      runId: null,
      messages: msgs,
      activityLog: [...get().activityLog, "[STOP] emergency stop — all execution terminated"],
    });
    get().showToast("Emergency stop — everything terminated");
  },

  loadProjects: async () => {
    await bindEvents(set, get);
    const projects = await api.listProjects();
    set({ projects });
    const current = get().activeProjectId;
    if (current && projects.some((p) => p.id === current)) return;
    const lastId = await api.kvGet("project.last").catch(() => null);
    const pick = projects.find((p) => p.id === lastId) ?? projects[0];
    await get().setActiveProject(pick ? pick.id : null);
  },

  updateProject: async (id, patch) => {
    await api.updateProject(id, patch);
    set({ projects: get().projects.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  },

  removeProject: async (id) => {
    await api.deleteProject(id);
    const projects = get().projects.filter((p) => p.id !== id);
    set({ projects });
    if (get().activeProjectId === id) await get().setActiveProject(projects[0]?.id ?? null);
  },

  setActiveProject: async (id) => {
    if (get().running && id !== get().activeProjectId) {
      const ok = await confirmDialog("Stop the running agent?", {
        message: "Switching projects stops the agent run in progress.",
        confirmLabel: "Stop and switch",
        danger: true,
      });
      if (!ok) return;
      await get().stopRun();
    }
    set({
      activeProjectId: id,
      messages: [],
      threads: [],
      sessionId: "",
      threadId: crypto.randomUUID(),
      pendingElement: null,
      activeFile: null,
      ev: emptyAgentEventState(),
    });
    if (!id) return;
    api.kvSet("project.last", id).catch(() => {});
    api
      .kvGet(`model.${id}`)
      .then((m) => {
        if (get().activeProjectId === id) set({ model: m ?? "" });
      })
      .catch(() => {});
    const p = get().projects.find((x) => x.id === id);
    if (p) api.startFsWatch(p.root).catch(() => {});
    const stored = await api.listMessages(id).catch(() => [] as StoredMessage[]);
    if (get().activeProjectId !== id) return;
    const threads = summarizeThreads(stored);
    set({ threads });
    if (threads.length > 0) await get().openThread(threads[0].id, stored);
  },

  activeProject: () => get().projects.find((p) => p.id === get().activeProjectId) ?? null,

  openThread: async (threadId, preloaded) => {
    const projectId = get().activeProjectId;
    if (!projectId || get().running) return;
    const stored = preloaded ?? (await api.listMessages(projectId).catch(() => [] as StoredMessage[]));
    if (get().activeProjectId !== projectId) return;
    const inThread = stored.filter((m) => threadOf(m) === threadId);
    const lastWithSession = [...inThread].reverse().find((m) => m.session_id);
    set({
      threadId,
      threads: summarizeThreads(stored),
      messages: inThread.map(storedToChat),
      sessionId: lastWithSession?.session_id ?? "",
      ev: { ...emptyAgentEventState(), sessionId: lastWithSession?.session_id ?? "" },
    });
  },

  sendMessage: async (text) => {
    const project = get().activeProject();
    if (!project || !text.trim() || get().running) return;
    const skill = get().pendingSkill;
    const element = get().pendingElement;
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text,
      tools: [],
      streaming: false,
      ts: Date.now(),
      meta: [skill ? `skill: ${skill}` : "", element ? `element: <${element.tag}>` : ""].filter(Boolean).join(" · ") || undefined,
    };
    const assistantMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      text: "",
      tools: [],
      streaming: true,
      ts: Date.now(),
    };
    set({
      messages: [...get().messages, userMsg, assistantMsg],
      running: true,
      runId: null,
      pendingElement: null,
      pendingSkill: null,
      activityLog: [],
      ev: { ...get().ev, committed: "", partial: "", segments: [], sessionId: get().sessionId },
    });
    const threadId = get().threadId;
    api.addMessage(project.id, get().sessionId, "user", text, JSON.stringify({ thread: threadId })).catch(() => {});

    const [memory, globalMemory] = await Promise.all([
      api.memoryList(project.id).catch(() => []),
      api.memoryList("global").catch(() => []),
    ]);
    const memoryBlock = [...globalMemory, ...memory].map((m) => `- [${m.kind}] ${m.title}: ${m.body}`).join("\n");
    let contextBlock = "";
    if (element) {
      contextBlock =
        `\n\n[Selected UI element from live preview]\n` +
        `tag: ${element.tag}\nselector: ${element.selector}\nclasses: ${element.classes.join(", ")}\n` +
        `text: ${element.text}\nhtml: ${element.html}`;
    }
    const fresh = get().activeProject() ?? project;
    const systemPrompt = [
      fresh.instructions ? `Project instructions:\n${fresh.instructions}` : "",
      memoryBlock ? `Relevant memory:\n${memoryBlock}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const fullPrompt = (skill ? `Use the "${skill}" skill for this task.\n\n` : "") + text + contextBlock;

    const autonomy = get().autonomy;
    api
      .auditWrite("run:start", `mode=${autonomy} model=${get().model || "default"} session=${get().sessionId || "new"} prompt="${text.slice(0, 120)}"`)
      .catch(() => {});
    try {
      const res = await api.startAgentRun(
        project.root,
        fullPrompt,
        get().sessionId || undefined,
        systemPrompt || undefined,
        autonomy,
        autonomy === "redline" ? undefined : get().model || undefined
      );
      if (get().running && get().runId === null) set({ runId: res.run_id });
      if (!get().threads.some((t) => t.id === threadId)) {
        set({
          threads: [{ id: threadId, title: text.replace(/\s+/g, " ").slice(0, 80), updated: Date.now(), count: 1 }, ...get().threads],
        });
      }
    } catch (e: any) {
      set((s) => ({
        running: false,
        runId: null,
        messages: s.messages.map((m) =>
          m.id === assistantMsg.id ? { ...m, streaming: false, error: true, text: `⚠ ${String(e)}` } : m
        ),
      }));
    }
  },

  stopRun: async () => {
    const runId = get().runId;
    if (runId) deadRuns.add(runId);
    if (runId) await api.cancelAgentRun(runId).catch(() => {});
    const lastIdx = get().messages.length - 1;
    const last = get().messages[lastIdx];
    let messages = get().messages;
    if (last?.streaming) {
      const stopped: ChatMessage = { ...last, streaming: false, thinking: false, meta: "stopped by user", text: last.text };
      messages = [...messages.slice(0, lastIdx), stopped];
      persistAssistant(get, stopped);
    }
    set({ running: false, runId: null, messages, ev: { ...get().ev, committed: "", partial: "", segments: [] } });
  },

  newSession: () => {
    if (get().running) return;
    set({ sessionId: "", messages: [], threadId: crypto.randomUUID(), ev: emptyAgentEventState() });
  },

  setPendingElement: (el) => set({ pendingElement: el }),
  setInspectorOpen: (open) => set({ inspectorOpen: open }),
  openFile: (path) => set(path ? { activeFile: path, rightTab: "editor" } : { activeFile: null }),
  setRightTab: (tab) => set({ rightTab: tab }),
  bumpTree: () => set((s) => ({ fileTreeVersion: s.fileTreeVersion + 1 })),
  setPendingSkill: (name) => set({ pendingSkill: name }),
  showToast: (msg) => {
    if (toastTimer) clearTimeout(toastTimer);
    set({ toast: msg });
    toastTimer = setTimeout(() => set({ toast: null }), Math.min(6000, 2200 + msg.length * 25));
  },
}));
