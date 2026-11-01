import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

export interface Project {
  id: string;
  name: string;
  root: string;
  instructions: string;
  preview_url: string;
  layout: string;
  created_at: string;
  updated_at: string;
}

export interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number;
}

export interface MemoryEntry {
  id: string;
  scope: string;
  kind: string;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface GitEntry {
  path: string;
  x: string;
  y: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface GitStatus {
  repo: boolean;
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  entries: GitEntry[];
}

export interface CommitInfo {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

export interface EnvInfo {
  fcc_claude: string | null;
  fcc_version: string;
  os: string;
  default_shell: string;
  claude: string | null;
  claude_version: string;
  node: string | null;
  git: string | null;
  browser_relay: string | null;
  relay_config_found: boolean;
}

export interface RelayStatus {
  broker_up: boolean;
  config_found: boolean;
  browser_relay_cli: boolean;
}

export interface SelectedElement {
  tag: string;
  id: string;
  classes: string[];
  selector: string;
  text: string;
  html: string;
  rect: { x: number; y: number; width: number; height: number };
}

export interface OllamaModel {
  name: string;
  size_gb: number;
  family: string;
  quantization: string;
  parameter_size: string;
  context_length: number;
  capabilities: string[];
}

export interface Hardware {
  gpu: string;
  vram_total_gb: number;
  vram_used_gb: number;
  ram_total_gb: number;
  ram_free_gb: number;
  disk_free_gb: number;
}

export interface RedlineStatus {
  proxy_up: boolean;
  proxy_model: string | null;
  redline_active: boolean;
  redline_model: string | null;
  ollama_up: boolean;
  lmstudio_up: boolean;
  models: OllamaModel[];
  hardware: Hardware | null;
}

export interface LeaderboardRow {
  model: string;
  avg_score: number;
  tasks_run: number;
  avg_latency_ms: number;
  last_run: string;
}

export interface ElevationStatus {
  is_admin: boolean;
  user: string;
  exe: string;
  os: string;
  can_request: boolean;
}

export interface StoredMessage {
  id: string;
  project_id: string;
  session_id: string;
  role: string;
  content: string;
  meta: string;
  created_at: string;
}

export interface AppInfo {
  version: string;
  os: string;
  arch: string;
  default_shell: string;
  data_dir: string;
}

export interface BenchProgress {
  model: string;
  task: string;
  done: boolean;
  finished: boolean;
  index: number;
  total: number;
  score: number;
  max: number;
  latency_ms: number;
  detail: string;
}

export interface SkillInfo {
  name: string;
  scope: string;
  path: string;
  description: string;
  modified: number;
}

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  listProjects: () => invoke<Project[]>("list_projects"),
  createProject: (name: string, root: string, instructions: string) =>
    invoke<Project>("create_project", { name, root, instructions }),
  updateProject: (id: string, patch: Partial<Pick<Project, "name" | "instructions" | "preview_url" | "layout">>) =>
    invoke<void>("update_project", { id, ...patch }),
  deleteProject: (id: string) => invoke<void>("delete_project", { id }),
  addMessage: (projectId: string, sessionId: string, role: string, content: string, meta: string) =>
    invoke<string>("add_message", { projectId, sessionId, role, content, meta }),
  listMessages: (projectId: string) => invoke<StoredMessage[]>("list_messages", { projectId }),
  clearMessages: (projectId: string) => invoke<void>("clear_messages", { projectId }),
  memoryList: (scope: string) => invoke<MemoryEntry[]>("memory_list", { scope }),
  memorySave: (id: string | null, scope: string, kind: string, title: string, body: string) =>
    invoke<MemoryEntry>("memory_save", { id, scope, kind, title, body }),
  memoryDelete: (id: string) => invoke<void>("memory_delete", { id }),
  kvGet: (key: string) => invoke<string | null>("kv_get", { key }),
  kvSet: (key: string, value: string) => invoke<void>("kv_set", { key, value }),

  listDir: (root: string, rel: string) => invoke<FsEntry[]>("list_dir", { root, rel }),
  readFile: (path: string) => invoke<string>("read_file", { path }),
  writeFile: (path: string, content: string) => invoke<void>("write_file", { path, content }),
  createDir: (path: string) => invoke<void>("create_dir", { path }),
  renamePath: (from: string, to: string) => invoke<void>("rename_path", { from, to }),
  deletePath: (path: string) => invoke<void>("delete_path", { path }),
  searchProject: (root: string, query: string) =>
    invoke<{ path: string; line: number; text: string }[]>("search_project", { root, query, maxResults: 300 }),
  openInExplorer: (path: string) => invoke<void>("open_in_explorer", { path }),
  pickFolder: (title?: string) => invoke<string | null>("pick_folder", { title: title ?? null }),
  startFsWatch: (root: string) => invoke<void>("start_fs_watch", { root }),

  detectEnvironment: () => invoke<EnvInfo>("detect_environment"),
  startAgentRun: (projectRoot: string, prompt: string, sessionId?: string, extraSystemPrompt?: string, autonomy?: string) =>
    invoke<{ run_id: string; pid: number }>("start_agent_run", {
      projectRoot,
      prompt,
      sessionId: sessionId ?? null,
      extraSystemPrompt: extraSystemPrompt ?? null,
      autonomy: autonomy ?? "normal",
    }),
  cancelAgentRun: (runId: string) => invoke<void>("cancel_agent_run", { runId }),

  ptyCreate: (program: string, cwd?: string, autonomy?: string, rows?: number, cols?: number) =>
    invoke<{ id: string; program: string }>("pty_create", {
      program,
      cwd: cwd ?? null,
      autonomy: autonomy ?? null,
      rows: rows ?? null,
      cols: cols ?? null,
    }),
  ptyWrite: (id: string, data: string) => invoke<void>("pty_write", { id, data }),
  ptyResize: (id: string, rows: number, cols: number) => invoke<void>("pty_resize", { id, rows, cols }),
  ptyKill: (id: string) => invoke<void>("pty_kill", { id }),
  ptyKillAll: () => invoke<void>("pty_kill_all"),

  relayStatus: () => invoke<RelayStatus>("relay_status"),
  openExternal: (url: string) => invoke<void>("open_external", { url }),

  previewStart: (root: string) => invoke<number>("preview_start", { root }),
  previewStop: () => invoke<void>("preview_stop"),
  previewState: () => invoke<number | null>("preview_state"),
  devServerScan: () => invoke<{ port: number; title: string }[]>("dev_server_scan"),

  gitStatus: (root: string) => invoke<GitStatus>("git_status", { root }),
  gitLog: (root: string, limit?: number) => invoke<CommitInfo[]>("git_log", { root, limit: limit ?? 50 }),
  gitDiff: (root: string, path?: string) => invoke<string>("git_diff", { root, path: path ?? null }),
  gitStage: (root: string, paths: string[]) => invoke<void>("git_stage", { root, paths }),
  gitUnstage: (root: string, paths: string[]) => invoke<void>("git_unstage", { root, paths }),
  gitDiscard: (root: string, path: string) => invoke<void>("git_discard", { root, path }),
  gitCommit: (root: string, message: string) => invoke<string>("git_commit", { root, message }),
  gitBranches: (root: string) => invoke<string[]>("git_branches", { root }),
  gitCheckout: (root: string, branch: string) => invoke<void>("git_checkout", { root, branch }),
  gitNewBranch: (root: string, name: string) => invoke<void>("git_new_branch", { root, name }),
  gitInit: (root: string) => invoke<void>("git_init", { root }),

  redlineStatus: () => invoke<RedlineStatus>("redline_status"),
  redlineActivate: (model: string) => invoke<void>("redline_activate", { model }),
  redlineDeactivate: () => invoke<void>("redline_deactivate"),
  redlineBenchmark: (model: string) => invoke<void>("redline_benchmark_start", { model }),
  redlineBenchRunning: () => invoke<boolean>("redline_bench_running"),
  redlineLeaderboard: () => invoke<LeaderboardRow[]>("redline_leaderboard"),
  redlineInstallOllama: () => invoke<string>("redline_install_ollama"),

  skillsList: (projectRoot: string | null) => invoke<{ skills: SkillInfo[]; names: string[] }>("skills_list", { projectRoot }),
  skillsRead: (path: string) => invoke<string>("skills_read", { path }),
  skillsWrite: (path: string, content: string) => invoke<void>("skills_write", { path, content }),
  skillsCreate: (scope: string, projectRoot: string | null, name: string) =>
    invoke<string>("skills_create", { scope, projectRoot, name }),
  skillsDelete: (path: string) => invoke<void>("skills_delete", { path }),

  elevationStatus: () => invoke<ElevationStatus>("elevation_status"),
  requestElevation: () => invoke<void>("request_elevation"),
  auditWrite: (event: string, detail: string) => invoke<void>("audit_write", { event, detail }),
  auditRead: () => invoke<string[]>("audit_read"),
};

export function listenEvent<T = any>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, (e) => handler(e.payload));
}
