import { create } from "zustand";
import { api, Project, SelectedElement } from "../lib/api";
import { listenEvent } from "../lib/api";
import { processAgentEvent, AgentEventState, emptyAgentEventState } from "../lib/agent-events";
export interface ToolActivity {
  id: string;
  name: string;
  input: any;
  result?: string;
  isError?: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  tools: ToolActivity[];
  streaming: boolean;
  ts: number;
  meta?: string;
}

interface AppState {
  projects: Project[];
  activeProjectId: string | null;
  sessionId: string;
  messages: ChatMessage[];
  running: boolean;
  runId: string | null;
  activityLog: string[];
  inspectorOpen: boolean;
  showRawActivity: boolean;
  pendingElement: SelectedElement | null;
  activeFile: string | null;
  fileTreeVersion: number;
  toast: string | null;
  autonomy: "normal" | "redline" | "yolo";
  isAdmin: boolean;
  pendingSkill: string | null;

  setAutonomy: (level: "normal" | "redline" | "yolo") => Promise<void>;
  setPendingSkill: (name: string | null) => void;
  refreshElevation: () => Promise<void>;
  emergencyStop: () => Promise<void>;
  __ev?: AgentEventState;

  loadProjects: () => Promise<void>;
  setActiveProject: (id: string | null) => Promise<void>;
  activeProject: () => Project | null;
  sendMessage: (text: string) => Promise<void>;
  stopRun: () => Promise<void>;
  newSession: () => void;
  setPendingElement: (el: SelectedElement | null) => void;
  openFile: (path: string | null) => void;
  bumpTree: () => void;
  showToast: (msg: string) => void;
  restoreMessages: (projectId: string) => Promise<void>;
}

let unlisten: (() => void) | null = null;

async function bindAgentEvents(set: any, get: any) {
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
  unlisten = await listenEvent<{ runId: string; event: any }>("agent-event", ({ runId, event }) => {
    set((s: AppState) => {
      const st: AgentEventState = (s as any).__ev ?? emptyAgentEventState();
      const next = processAgentEvent(st, event, s.messages);
      const patch: any = { messages: next.messages, __ev: next.evState };
      if (next.finished) patch.running = false;
      return patch;
    });
    const evState = (get() as any).__ev as AgentEventState | undefined;
    if (evState?.sessionId) {
      set({ sessionId: evState.sessionId });
    }
    if (event?.type === "result") {
      const projectId = get().activeProjectId;
      const sid = (get() as any).__ev?.sessionId ?? "";
      const msgs = get().messages;
      const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
      if (projectId && lastAssistant) {
        api
          .addMessage(projectId, sid, "assistant", JSON.stringify({ text: lastAssistant.text, tools: lastAssistant.tools }), "{}")
          .catch(() => {});
      }
    }
  });

  await listenEvent<{ runId: string; text: string }>("agent-stderr", ({ text }) => {
    set((s: AppState) => ({ activityLog: [...s.activityLog.slice(-300), `[stderr] ${text}`] }));
  });

  await listenEvent<{ runId: string; code: number }>("agent-exit", ({ code }) => {
    set((s: AppState) => {
      const msgs = s.messages.map((m, i) =>
        i === s.messages.length - 1 && m.streaming ? { ...m, streaming: false } : m
      );
      const log = [...s.activityLog, `[exit] agent process exited with code ${code}`];
      return { running: false, runId: null, messages: msgs, activityLog: log.slice(-300) };
    });
  });
}

export const useApp = create<AppState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  sessionId: "",
  messages: [],
  running: false,
  runId: null,
  activityLog: [],
  inspectorOpen: true,
  showRawActivity: false,
  pendingElement: null,
  activeFile: null,
  fileTreeVersion: 0,
  toast: null,
  autonomy: "yolo",
  isAdmin: false,
  pendingSkill: null,
  __ev: undefined as any,

  setAutonomy: async (level) => {
    if (level === "yolo" && level !== get().autonomy) {
      if (!confirm("YOLO Mode: the agent gains maximum autonomy — no permission prompts, skip-permissions enabled, and commands run without individual approval. Enable?")) return;
    }
    const prev = get().autonomy;
    try {
      if (level === "redline" && prev !== "redline") {
        const model = await api.kvGet("redline.model");
        if (!model) {
          showToast2("Pick a local model in the Redline tab first");
          return;
        }
        await api.redlineActivate(model);
      }
      if (prev === "redline" && level !== "redline") {
        await api.redlineDeactivate().catch(() => {});
      }
    } catch (e) {
      showToast2(String(e));
      return;
    }
    set({ autonomy: level });
    await api.kvSet("autonomy.level", level);
    await api
      .auditWrite(`mode:${level}`, `mode changed ${prev} -> ${level}`)
      .catch(() => {});
  },

  refreshElevation: async () => {
    const st = await api.elevationStatus().catch(() => null);
    set({ isAdmin: st?.is_admin ?? false });
    const level = (await api.kvGet("autonomy.level").catch(() => null)) as any;
    if (level === "normal" || level === "redline" || level === "yolo") set({ autonomy: level });
  },

  emergencyStop: async () => {
    const runId = get().runId;
    if (runId) await api.cancelAgentRun(runId).catch(() => {});
    await api.ptyKillAll().catch(() => {});
    await api.auditWrite("emergency_stop", "emergency stop: agent run and all terminal sessions terminated").catch(() => {});
    set({ running: false, runId: null, activityLog: [...get().activityLog, "[STOP] emergency stop — all execution terminated"] });
    showToast2("Emergency stop — everything terminated");
  },

  loadProjects: async () => {
    const projects = await api.listProjects();
    set({ projects });
    if (!get().activeProjectId && projects.length > 0) {
      await get().setActiveProject(projects[0].id);
    }
  },

  setActiveProject: async (id) => {
    set({ activeProjectId: id, messages: [], sessionId: "", pendingElement: null, __ev: emptyAgentEventState() });
    if (id) {
      await bindAgentEvents(set, get);
      await get().restoreMessages(id);
      const p = get().projects.find((x) => x.id === id);
      if (p) {
        api.startFsWatch(p.root).catch(() => {});
      }
    }
  },

  activeProject: () => get().projects.find((p) => p.id === get().activeProjectId) ?? null,

  restoreMessages: async (projectId) => {
    const stored = await api.listMessages(projectId).catch(() => []);
    const msgs: ChatMessage[] = stored.map((m) => {
      let text = "";
      let tools: ToolActivity[] = [];
      try {
        if (m.role === "assistant") {
          const parsed = JSON.parse(m.content);
          text = parsed.text ?? "";
          tools = parsed.tools ?? [];
        } else {
          text = m.content;
        }
      } catch {
        text = m.content;
      }
      return {
        id: m.id,
        role: m.role as ChatMessage["role"],
        text,
        tools,
        streaming: false,
        ts: new Date(m.created_at).getTime(),
      };
    });
    set({ messages: msgs });
  },

  sendMessage: async (text) => {
    const project = get().activeProject();
    if (!project || !text.trim() || get().running) return;
    const skill = get().pendingSkill;
    const fullText = skill ? `Use the "${skill}" skill for this task.\n\n${text}` : text;
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
    set({
      messages: [...get().messages, userMsg, assistantMsg],
      running: true,
      pendingElement: null,
      activityLog: [],
    });
    api
      .addMessage(project.id, get().sessionId, "user", text, "{}")      .catch(() => {});

    const memory = await api.memoryList(project.id).catch(() => []);
    const globalMemory = await api.memoryList("global").catch(() => []);
    const memoryBlock = [...globalMemory, ...memory]
      .map((m) => `- [${m.kind}] ${m.title}: ${m.body}`)
      .join("\n");
    const element = get().pendingElement;
    let contextBlock = "";
    if (element) {
      contextBlock =
        `\n\n[Selected UI element from live preview]\n` +
        `tag: ${element.tag}\nselector: ${element.selector}\nclasses: ${element.classes.join(", ")}\n` +
        `text: ${element.text}\nhtml: ${element.html}`;
    }
    const systemPrompt =
      (project.instructions ? `Project instructions:\n${project.instructions}\n` : "") +
      (memoryBlock ? `Relevant memory:\n${memoryBlock}` : "");
    const fullPrompt = fullText + contextBlock;

    const autonomy = get().autonomy;
    api
      .auditWrite(`run:start`, `mode=${autonomy} session=${get().sessionId || "new"} prompt="${text.slice(0, 120)}"`)
      .catch(() => {});
    try {
      const res = await api.startAgentRun(
        project.root,
        fullPrompt,
        get().sessionId || undefined,
        systemPrompt || undefined,
        autonomy
      );
      set({ runId: res.run_id, pendingSkill: null });
    } catch (e: any) {
      set((s: AppState) => ({
        running: false,
        messages: s.messages.map((m) => (m.id === assistantMsg.id ? { ...m, streaming: false, text: `⚠ ${String(e)}` } : m)),
      }));
    }
  },

  stopRun: async () => {
    const runId = get().runId;
    if (runId) {
      await api.cancelAgentRun(runId).catch(() => {});
    }
    set({ running: false, runId: null });
  },

  newSession: () => set({ sessionId: "", messages: [], __ev: emptyAgentEventState() }),

  setPendingElement: (el) => set({ pendingElement: el }),
  openFile: (path) => set({ activeFile: path }),
  bumpTree: () => set((s: AppState) => ({ fileTreeVersion: s.fileTreeVersion + 1 })),
  setPendingSkill: (name) => set({ pendingSkill: name }),
  showToast: (msg) => {
    set({ toast: msg });
    setTimeout(() => set({ toast: null }), 2600);
  },
}));

function showToast2(msg: string) {
  useApp.getState().showToast(msg);
}
