import { create } from "zustand";
import { api, listenEvent, Project, SelectedElement, SessionSummary, StoredMessage } from "../lib/api";
import {
  AgentEventState,
  ChatMessage,
  ToolActivity,
  emptyAgentEventState,
  finalizeStreaming,
  processAgentEvent,
} from "../lib/agent-events";
import { buildPrompt } from "../lib/prompt";

export type { ChatMessage, ToolActivity } from "../lib/agent-events";

export type Autonomy = "normal" | "redline" | "yolo";

export interface Layout {
  leftW: number;
  rightW: number;
  leftOpen: boolean;
  rightOpen: boolean;
  rightTab: string;
}

export const DEFAULT_LAYOUT: Layout = {
  leftW: 268,
  rightW: 480,
  leftOpen: true,
  rightOpen: true,
  rightTab: "preview",
};

const LOG_LIMIT = 400;
const STORED_RESULT_CHARS = 2000;

interface AppState {
  projects: Project[];
  activeProjectId: string | null;
  sessionId: string;
  sessions: SessionSummary[];
  messages: ChatMessage[];
  running: boolean;
  runId: string | null;
  activityLog: string[];
  inspectorOpen: boolean;
  pendingElement: SelectedElement | null;
  activeFile: string | null;
  fileTreeVersion: number;
  fsVersion: number;
  toast: string | null;
  autonomy: Autonomy;
  isAdmin: boolean;
  pendingSkill: string | null;
  layout: Layout;
  ev: AgentEventState;

  setAutonomy: (level: Autonomy) => Promise<void>;
  setPendingSkill: (name: string | null) => void;
  refreshElevation: () => Promise<void>;
  emergencyStop: () => Promise<void>;
  loadProjects: () => Promise<void>;
  setActiveProject: (id: string | null) => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  patchProject: (id: string, patch: Partial<Pick<Project, "name" | "instructions" | "preview_url" | "layout">>) => Promise<void>;
  activeProject: () => Project | null;
  sendMessage: (text: string) => Promise<void>;
  stopRun: () => Promise<void>;
  newSession: () => void;
  openSession: (sessionId: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
  setPendingElement: (el: SelectedElement | null) => void;
  openFile: (path: string | null) => void;
  bumpTree: () => void;
  showToast: (msg: string) => void;
  restoreMessages: (projectId: string, sessionId?: string) => Promise<void>;
  setInspectorOpen: (open: boolean) => void;
  updateLayout: (patch: Partial<Layout>) => void;
  loadLayout: () => Promise<void>;
}

let listenersReady: Promise<void> | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let layoutTimer: ReturnType<typeof setTimeout> | null = null;

function pushLog(log: string[], ...lines: string[]): string[] {
  const next = [...log, ...lines];
  return next.length > LOG_LIMIT ? next.slice(-LOG_LIMIT) : next;
}

function serializeAssistant(m: ChatMessage): string {
  return JSON.stringify({
    text: m.text,
    tools: m.tools.map((t) => ({ ...t, result: t.result?.slice(0, STORED_RESULT_CHARS) })),
    stats: m.stats,
    error: m.error,
  });
}

export function hydrateMessage(m: StoredMessage): ChatMessage {
  let text = m.content;
  let tools: ToolActivity[] = [];
  let stats: ChatMessage["stats"];
  let error: boolean | undefined;
  if (m.role === "assistant") {
    try {
      const parsed = JSON.parse(m.content);
      if (parsed && typeof parsed === "object") {
        text = parsed.text ?? "";
        tools = Array.isArray(parsed.tools) ? parsed.tools : [];
        stats = parsed.stats;
        error = parsed.error;
      }
    } catch {
      text = m.content;
    }
  }
  return {
    id: m.id,
    role: (m.role as ChatMessage["role"]) ?? "assistant",
    text,
    tools,
    streaming: false,
    ts: new Date(m.created_at).getTime(),
    stats,
    error,
  };
}

function persistAssistant(get: () => AppState) {
  const { activeProjectId, ev, messages } = get();
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  if (!activeProjectId || !lastAssistant || (!lastAssistant.text && lastAssistant.tools.length === 0)) return;
  api.addMessage(activeProjectId, ev.sessionId, "assistant", serializeAssistant(lastAssistant), "{}").catch(() => {});
  if (ev.sessionId) {
    api
      .updateMessageSession(activeProjectId, ev.sessionId)
      .then(() => get().refreshSessions())
      .catch(() => {});
  }
}

type RunEvent =
  | { kind: "event"; runId: string; event: any }
  | { kind: "stderr"; runId: string; text: string }
  | { kind: "exit"; runId: string; code: number };

let earlyEvents: RunEvent[] = [];

type Setter = (p: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void;

function handleRunEvent(e: RunEvent, set: Setter, get: () => AppState) {
  if (e.kind === "event") {
    let finished = false;
    set((s) => {
      const next = processAgentEvent(s.ev, e.event, s.messages);
      finished = next.finished;
      const patch: Partial<AppState> = { messages: next.messages, ev: next.evState };
      if (next.evState.sessionId && next.evState.sessionId !== s.sessionId) patch.sessionId = next.evState.sessionId;
      if (next.log) patch.activityLog = pushLog(s.activityLog, next.log);
      if (next.finished) patch.running = false;
      return patch;
    });
    if (finished) persistAssistant(get);
  } else if (e.kind === "stderr") {
    set((s) => ({ activityLog: pushLog(s.activityLog, ...e.text.split("\n").map((l) => `[stderr] ${l}`)) }));
  } else {
    const wasStreaming = get().messages.at(-1)?.streaming ?? false;
    set((s) => ({
      running: false,
      runId: null,
      messages: finalizeStreaming(s.messages, e.code),
      activityLog: pushLog(s.activityLog, `[exit] agent process exited with code ${e.code}`),
    }));
    if (wasStreaming) persistAssistant(get);
  }
}

function routeRunEvent(e: RunEvent, set: Setter, get: () => AppState) {
  const { runId, running } = get();
  if (runId === e.runId) {
    handleRunEvent(e, set, get);
  } else if (running && runId === null) {
    earlyEvents.push(e);
  }
}

function adoptRun(runId: string, set: Setter, get: () => AppState) {
  set({ runId });
  const buffered = earlyEvents.filter((e) => e.runId === runId);
  earlyEvents = [];
  for (const e of buffered) {
    if (get().runId !== runId) break;
    handleRunEvent(e, set, get);
  }
}

function ensureListeners(set: Setter, get: () => AppState) {
  if (listenersReady) return listenersReady;
  listenersReady = (async () => {
    await listenEvent<{ runId: string; event: any }>("agent-event", ({ runId, event }) =>
      routeRunEvent({ kind: "event", runId, event }, set, get)
    );
    await listenEvent<{ runId: string; text: string }>("agent-stderr", ({ runId, text }) =>
      routeRunEvent({ kind: "stderr", runId, text }, set, get)
    );
    await listenEvent<{ runId: string; code: number }>("agent-exit", ({ runId, code }) =>
      routeRunEvent({ kind: "exit", runId, code }, set, get)
    );
    await listenEvent<{ root: string }>("fs-changed", ({ root }) => {
      const p = get().activeProject();
      if (p && p.root === root) {
        set((s) => ({ fileTreeVersion: s.fileTreeVersion + 1, fsVersion: s.fsVersion + 1 }));
      }
    });
  })();
  return listenersReady;
}

export const useApp = create<AppState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  sessionId: "",
  sessions: [],
  messages: [],
  running: false,
  runId: null,
  activityLog: [],
  inspectorOpen: true,
  pendingElement: null,
  activeFile: null,
  fileTreeVersion: 0,
  fsVersion: 0,
  toast: null,
  autonomy: "yolo",
  isAdmin: false,
  pendingSkill: null,
  layout: DEFAULT_LAYOUT,
  ev: emptyAgentEventState(),

  setAutonomy: async (level) => {
    const prev = get().autonomy;
    if (level === prev) return;
    if (
      level === "yolo" &&
      !confirm(
        "YOLO Mode: the agent gains maximum autonomy — no permission prompts, skip-permissions enabled, and commands run without individual approval. Enable?"
      )
    )
      return;
    try {
      if (level === "redline") {
        const model = await api.kvGet("redline.model");
        if (!model) {
          get().showToast("Pick a local model in the Redline tab first");
          return;
        }
        await api.redlineActivate(model);
      } else if (prev === "redline") {
        await api.redlineDeactivate();
      }
    } catch (e) {
      get().showToast(String(e));
      return;
    }
    set({ autonomy: level });
    await api.kvSet("autonomy.level", level).catch(() => {});
    api.auditWrite(`mode:${level}`, `mode changed ${prev} -> ${level}`).catch(() => {});
  },

  refreshElevation: async () => {
    const st = await api.elevationStatus().catch(() => null);
    set({ isAdmin: st?.is_admin ?? false });
  },

  emergencyStop: async () => {
    const runId = get().runId;
    if (runId) await api.cancelAgentRun(runId).catch(() => {});
    await api.ptyKillAll().catch(() => {});
    await api.auditWrite("emergency_stop", "emergency stop: agent run and all terminal sessions terminated").catch(() => {});
    set((s) => ({
      running: false,
      runId: null,
      messages: finalizeStreaming(s.messages, 130),
      activityLog: pushLog(s.activityLog, "[STOP] emergency stop — all execution terminated"),
    }));
    get().showToast("Emergency stop — everything terminated");
  },

  loadProjects: async () => {
    await ensureListeners(set, get);
    const level = await api.kvGet("autonomy.level").catch(() => null);
    if (level === "normal" || level === "redline" || level === "yolo") set({ autonomy: level });
    const projects = await api.listProjects();
    set({ projects });
    const current = get().activeProjectId;
    if (current && projects.some((p) => p.id === current)) return;
    const remembered = await api.kvGet("ui.activeProject").catch(() => null);
    const pick = projects.find((p) => p.id === remembered) ?? projects[0];
    await get().setActiveProject(pick ? pick.id : null);
  },

  setActiveProject: async (id) => {
    if (get().running) await get().stopRun();
    set({
      activeProjectId: id,
      messages: [],
      sessions: [],
      sessionId: "",
      pendingElement: null,
      activeFile: null,
      activityLog: [],
      ev: emptyAgentEventState(),
    });
    if (!id) return;
    api.kvSet("ui.activeProject", id).catch(() => {});
    const p = get().projects.find((x) => x.id === id);
    if (p) api.startFsWatch(p.root).catch(() => {});
    await get().refreshSessions();
    const latest = get().sessions[0]?.session_id;
    await get().restoreMessages(id, latest);
  },

  removeProject: async (id) => {
    await api.deleteProject(id);
    const projects = await api.listProjects();
    set({ projects });
    if (get().activeProjectId === id) await get().setActiveProject(projects[0]?.id ?? null);
  },

  patchProject: async (id, patch) => {
    await api.updateProject(id, patch);
    set((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
  },

  activeProject: () => get().projects.find((p) => p.id === get().activeProjectId) ?? null,

  refreshSessions: async () => {
    const id = get().activeProjectId;
    if (!id) return;
    const sessions = await api.listSessions(id).catch(() => []);
    if (get().activeProjectId === id) set({ sessions });
  },

  restoreMessages: async (projectId, sessionId) => {
    const stored = await api.listMessages(projectId, sessionId ?? null, 400).catch(() => [] as StoredMessage[]);
    if (get().activeProjectId !== projectId) return;
    set({
      messages: stored.map(hydrateMessage),
      sessionId: sessionId ?? "",
      ev: { ...emptyAgentEventState(), sessionId: sessionId ?? "" },
    });
  },

  openSession: async (sessionId) => {
    const id = get().activeProjectId;
    if (!id || get().running) return;
    await get().restoreMessages(id, sessionId);
  },

  sendMessage: async (text) => {
    const project = get().activeProject();
    if (!project || !text.trim() || get().running) return;
    const element = get().pendingElement;
    const skill = get().pendingSkill;
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text,
      tools: [],
      streaming: false,
      ts: Date.now(),
    };
    const assistantMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      text: "",
      tools: [],
      streaming: true,
      ts: Date.now(),
    };
    earlyEvents = [];
    set((s) => ({
      messages: [...s.messages, userMsg, assistantMsg],
      running: true,
      runId: null,
      pendingElement: null,
      pendingSkill: null,
      activityLog: [],
      ev: { ...emptyAgentEventState(), sessionId: s.sessionId },
    }));
    api.addMessage(project.id, get().sessionId, "user", text, "{}").catch(() => {});

    const [memory, globalMemory] = await Promise.all([
      api.memoryList(project.id).catch(() => []),
      api.memoryList("global").catch(() => []),
    ]);
    const { prompt, systemPrompt } = buildPrompt({
      text,
      skill,
      element,
      instructions: project.instructions,
      memory: [...globalMemory, ...memory],
    });

    const autonomy = get().autonomy;
    api
      .auditWrite("run:start", `mode=${autonomy} session=${get().sessionId || "new"} prompt="${text.slice(0, 120)}"`)
      .catch(() => {});
    try {
      const res = await api.startAgentRun(project.root, prompt, get().sessionId || undefined, systemPrompt || undefined, autonomy);
      if (!get().running) {
        earlyEvents = [];
        await api.cancelAgentRun(res.run_id).catch(() => {});
        return;
      }
      set((s) => ({ activityLog: pushLog(s.activityLog, `[start] pid ${res.pid} · mode ${autonomy}`) }));
      adoptRun(res.run_id, set, get);
    } catch (e: any) {
      earlyEvents = [];
      set((s) => ({
        running: false,
        messages: s.messages.map((m) =>
          m.id === assistantMsg.id ? { ...m, streaming: false, error: true, text: `⚠ ${String(e)}` } : m
        ),
      }));
    }
  },

  stopRun: async () => {
    const runId = get().runId;
    set((s) => ({ running: false, runId: null, messages: finalizeStreaming(s.messages, 130) }));
    if (runId) await api.cancelAgentRun(runId).catch(() => {});
  },

  newSession: () => {
    if (get().running) return;
    set({ sessionId: "", messages: [], activityLog: [], ev: emptyAgentEventState() });
  },

  setPendingElement: (el) => set({ pendingElement: el }),
  openFile: (path) => {
    set({ activeFile: path });
    if (path) get().updateLayout({ rightOpen: true, rightTab: "editor" });
  },
  bumpTree: () => set((s) => ({ fileTreeVersion: s.fileTreeVersion + 1 })),
  setPendingSkill: (name) => set({ pendingSkill: name }),
  setInspectorOpen: (open) => set({ inspectorOpen: open }),
  showToast: (msg) => {
    if (toastTimer) clearTimeout(toastTimer);
    set({ toast: msg });
    toastTimer = setTimeout(() => set({ toast: null }), 3200);
  },

  updateLayout: (patch) => {
    set((s) => ({ layout: { ...s.layout, ...patch } }));
    if (layoutTimer) clearTimeout(layoutTimer);
    layoutTimer = setTimeout(() => {
      api.kvSet("ui.layout", JSON.stringify(get().layout)).catch(() => {});
    }, 400);
  },

  loadLayout: async () => {
    const raw = await api.kvGet("ui.layout").catch(() => null);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      set({ layout: { ...DEFAULT_LAYOUT, ...parsed } });
    } catch {
      set({ layout: DEFAULT_LAYOUT });
    }
  },
}));
