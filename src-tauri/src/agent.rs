use serde::Serialize;
use std::collections::HashMap;
use std::io::Write;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

use crate::platform;

#[derive(Default, Clone)]
pub struct AgentState {
    pub runs: Arc<Mutex<HashMap<String, RunHandle>>>,
}

#[derive(Clone)]
pub struct RunHandle {
    pub pid: u32,
}

impl AgentState {
    pub fn kill_all(&self) {
        let pids: Vec<u32> = self
            .runs
            .lock()
            .map(|mut m| m.drain().map(|(_, h)| h.pid).collect())
            .unwrap_or_default();
        for pid in pids {
            platform::kill_tree(pid);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RunStarted {
    pub run_id: String,
    pub pid: u32,
}

pub fn agent_binary() -> Option<String> {
    platform::which("fcc-claude")
}

pub fn permission_args(autonomy: &str) -> Vec<String> {
    match autonomy {
        "normal" => vec!["--permission-mode".into(), "default".into()],
        "redline" => vec!["--permission-mode".into(), "acceptEdits".into()],
        _ => vec!["--dangerously-skip-permissions".into()],
    }
}

pub fn build_command(binary: &str, args: &[String]) -> std::process::Command {
    if let Some((node, script)) = platform::resolve_node_shim(binary) {
        let mut cmd = platform::command(node);
        cmd.arg(script).args(args);
        return cmd;
    }
    if platform::is_batch(binary) {
        let flattened: Vec<String> = args
            .iter()
            .map(|a| a.replace("\r\n", " ").replace(['\n', '\r'], " "))
            .collect();
        let mut cmd = platform::command(binary);
        cmd.args(flattened);
        return cmd;
    }
    let mut cmd = platform::command(binary);
    cmd.args(args);
    cmd
}

fn version_of(path: &str) -> String {
    build_command(path, &["--version".to_string()])
        .stdin(Stdio::null())
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn detect_environment() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let fcc = agent_binary();
        let claude = platform::which("claude");
        let node = platform::which("node");
        let git = platform::which("git");
        let browser_relay = platform::which("browser-relay");
        let relay_config = platform::home_dir()
            .map(|h| h.join(".relay").exists())
            .unwrap_or(false);
        let claude_version = claude.as_deref().map(version_of).unwrap_or_default();
        let fcc_version = fcc.as_deref().map(version_of).unwrap_or_default();
        serde_json::json!({
            "fcc_claude": fcc,
            "fcc_version": fcc_version,
            "claude": claude,
            "claude_version": claude_version,
            "node": node,
            "git": git,
            "browser_relay": browser_relay,
            "relay_config_found": relay_config,
            "os": std::env::consts::OS,
            "default_shell": platform::default_shell(),
        })
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn start_agent_run(
    app: tauri::AppHandle,
    state: tauri::State<AgentState>,
    project_root: String,
    prompt: String,
    session_id: Option<String>,
    extra_system_prompt: Option<String>,
    autonomy: Option<String>,
) -> Result<RunStarted, String> {
    let fcc = agent_binary().ok_or("fcc-claude not found on PATH. Install Free Claude Code first.")?;
    let root = std::path::PathBuf::from(&project_root);
    if !root.is_dir() {
        return Err(format!("project root does not exist: {project_root}"));
    }

    let autonomy = autonomy.unwrap_or_else(|| "normal".to_string());
    let mut args: Vec<String> = vec![
        "-p".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--include-partial-messages".into(),
        "--verbose".into(),
    ];
    args.extend(permission_args(&autonomy));
    if let Some(sid) = session_id.as_ref().filter(|s| !s.is_empty()) {
        args.push("--resume".into());
        args.push(sid.clone());
    }
    if let Some(sp) = extra_system_prompt.as_ref().filter(|s| !s.is_empty()) {
        args.push("--append-system-prompt".into());
        args.push(sp.clone());
    }

    let mut cmd = build_command(&fcc, &args);
    cmd.current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    platform::detach_group(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| format!("failed to launch fcc-claude: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        let prompt_bytes = prompt.into_bytes();
        std::thread::spawn(move || {
            let _ = stdin.write_all(&prompt_bytes);
            let _ = stdin.flush();
        });
    }
    let pid = child.id();
    let run_id = uuid::Uuid::new_v4().to_string();

    state
        .runs
        .lock()
        .map_err(|e| e.to_string())?
        .insert(run_id.clone(), RunHandle { pid });

    let stdout_thread = child.stdout.take().map(|stdout| {
        let app_handle = app.clone();
        let rid = run_id.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(l) = line else { break };
                if l.trim().is_empty() {
                    continue;
                }
                let parsed: serde_json::Value =
                    serde_json::from_str(&l).unwrap_or(serde_json::Value::String(l.clone()));
                let _ = app_handle.emit(
                    "agent-event",
                    serde_json::json!({ "runId": rid, "event": parsed }),
                );
            }
        })
    });

    let stderr_thread = child.stderr.take().map(|stderr| {
        let app_handle = app.clone();
        let rid = run_id.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                let Ok(l) = line else { break };
                if l.trim().is_empty() {
                    continue;
                }
                let _ = app_handle.emit(
                    "agent-stderr",
                    serde_json::json!({ "runId": rid, "text": l }),
                );
            }
        })
    });

    let app2 = app.clone();
    let run_id2 = run_id.clone();
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
        if let Some(t) = stdout_thread {
            let _ = t.join();
        }
        if let Some(t) = stderr_thread {
            let _ = t.join();
        }
        if let Some(st) = app2.try_state::<AgentState>() {
            if let Ok(mut runs) = st.runs.lock() {
                runs.remove(&run_id2);
            }
        }
        let _ = app2.emit(
            "agent-exit",
            serde_json::json!({ "runId": run_id2, "code": code }),
        );
    });

    Ok(RunStarted { run_id, pid })
}

#[tauri::command]
pub fn cancel_agent_run(state: tauri::State<AgentState>, run_id: String) -> Result<(), String> {
    let handle = state
        .runs
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&run_id);
    if let Some(h) = handle {
        platform::kill_tree(h.pid);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn autonomy_maps_to_cli_flags() {
        assert_eq!(permission_args("normal"), vec!["--permission-mode", "default"]);
        assert_eq!(permission_args("redline"), vec!["--permission-mode", "acceptEdits"]);
        assert_eq!(permission_args("yolo"), vec!["--dangerously-skip-permissions"]);
    }
}
