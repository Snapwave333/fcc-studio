use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

use crate::proc;

#[derive(Default)]
pub struct AgentState {
    pub runs: Mutex<HashMap<String, RunHandle>>,
}

pub struct RunHandle {
    pub pid: u32,
}

impl AgentState {
    pub fn kill_all(&self) {
        if let Ok(mut runs) = self.runs.lock() {
            for (_, handle) in runs.drain() {
                proc::kill_tree(handle.pid);
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RunStarted {
    pub run_id: String,
    pub pid: u32,
}

fn tool_version(path: &str) -> String {
    proc::command(path)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn detect_environment() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let fcc = proc::find_executable("fcc-claude");
        let claude = proc::find_executable("claude");
        let node = proc::find_executable("node");
        let git = proc::find_executable("git");
        let browser_relay = proc::find_executable("browser-relay");
        let relay_config = proc::home_dir().map(|h| h.join(".relay").exists()).unwrap_or(false);
        let claude_version = claude.as_deref().map(tool_version).unwrap_or_default();
        let node_version = node.as_deref().map(tool_version).unwrap_or_default();
        let git_version = git.as_deref().map(tool_version).unwrap_or_default();
        serde_json::json!({
            "fcc_claude": fcc,
            "claude": claude,
            "claude_version": claude_version,
            "node": node,
            "node_version": node_version,
            "git": git,
            "git_version": git_version,
            "browser_relay": browser_relay,
            "relay_config_found": relay_config,
            "platform": std::env::consts::OS,
        })
    })
    .await
    .map_err(|e| e.to_string())
}

pub fn permission_args(autonomy: &str) -> Vec<&'static str> {
    match autonomy {
        "normal" => vec!["--permission-mode", "default"],
        "redline" => vec!["--permission-mode", "acceptEdits"],
        _ => vec!["--dangerously-skip-permissions"],
    }
}

#[tauri::command]
pub fn start_agent_run<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, AgentState>,
    project_root: String,
    prompt: String,
    session_id: Option<String>,
    extra_system_prompt: Option<String>,
    autonomy: Option<String>,
) -> Result<RunStarted, String> {
    let fcc = proc::find_executable("fcc-claude")
        .ok_or("fcc-claude not found on PATH. Install Free Claude Code first.")?;
    let root = std::path::PathBuf::from(&project_root);
    if !root.is_dir() {
        return Err(format!("project root does not exist: {project_root}"));
    }

    let autonomy = autonomy.unwrap_or_else(|| "yolo".to_string());
    let mut cmd = proc::command(&fcc);
    cmd.current_dir(&root)
        .arg("-p")
        .arg(&prompt)
        .args(["--output-format", "stream-json", "--include-partial-messages", "--verbose"])
        .args(permission_args(&autonomy));
    if let Some(sid) = session_id.as_deref().filter(|s| !s.is_empty()) {
        cmd.arg("--resume").arg(sid);
    }
    if let Some(sp) = extra_system_prompt.as_deref().filter(|s| !s.is_empty()) {
        cmd.arg("--append-system-prompt").arg(sp);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("failed to launch fcc-claude: {e}"))?;
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
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                let parsed: serde_json::Value =
                    serde_json::from_str(&line).unwrap_or(serde_json::Value::String(line));
                let _ = app_handle.emit("agent-event", serde_json::json!({ "runId": rid, "event": parsed }));
            }
        })
    });

    let stderr_thread = child.stderr.take().map(|stderr| {
        let app_handle = app.clone();
        let rid = run_id.clone();
        std::thread::spawn(move || {
            let mut buf = String::new();
            let mut last_flush = Instant::now();
            let flush = |buf: &mut String| {
                if !buf.is_empty() {
                    let _ = app_handle.emit("agent-stderr", serde_json::json!({ "runId": rid, "text": buf.trim_end() }));
                    buf.clear();
                }
            };
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                buf.push_str(&line);
                buf.push('\n');
                if buf.len() > 4000 || last_flush.elapsed() > Duration::from_millis(250) {
                    flush(&mut buf);
                    last_flush = Instant::now();
                }
            }
            flush(&mut buf);
        })
    });

    let app_exit = app.clone();
    let rid_exit = run_id.clone();
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
        if let Some(t) = stdout_thread {
            let _ = t.join();
        }
        if let Some(t) = stderr_thread {
            let _ = t.join();
        }
        if let Ok(mut runs) = app_exit.state::<AgentState>().runs.lock() {
            runs.remove(&rid_exit);
        }
        let _ = app_exit.emit("agent-exit", serde_json::json!({ "runId": rid_exit, "code": code }));
    });

    Ok(RunStarted { run_id, pid })
}

#[tauri::command]
pub fn cancel_agent_run(state: tauri::State<AgentState>, run_id: String) -> Result<(), String> {
    let handle = state.runs.lock().map_err(|e| e.to_string())?.remove(&run_id);
    if let Some(h) = handle {
        proc::kill_tree(h.pid);
    }
    Ok(())
}

#[tauri::command]
pub fn active_agent_runs(state: tauri::State<AgentState>) -> Result<Vec<String>, String> {
    Ok(state.runs.lock().map_err(|e| e.to_string())?.keys().cloned().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn runs_agent_end_to_end_without_shell_injection() {
        use std::os::unix::fs::PermissionsExt;
        use std::sync::mpsc;
        use tauri::Listener;
        let bin = std::env::temp_dir().join(format!("fcc-bin-{}", uuid::Uuid::new_v4()));
        let work = std::env::temp_dir().join(format!("fcc-work-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&work).unwrap();
        let script = bin.join("fcc-claude");
        std::fs::write(
            &script,
            "#!/bin/sh\nprintf '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"s1\",\"cwd\":\"%s\"}\\n' \"$(pwd)\"\nprintf '%s' \"$2\" > received_prompt.txt\nprintf '{\"type\":\"argv\",\"count\":%s}\\n' \"$#\"\necho 'not json'\necho 'warn line' >&2\nexit 3\n",
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default());
        std::env::set_var("PATH", path);

        let app = tauri::test::mock_app();
        app.manage(AgentState::default());
        let (tx, rx) = mpsc::channel::<(String, serde_json::Value)>();
        for name in ["agent-event", "agent-stderr", "agent-exit"] {
            let tx = tx.clone();
            app.listen_any(name, move |e| {
                let v: serde_json::Value = serde_json::from_str(e.payload()).unwrap();
                let _ = tx.send((name.to_string(), v));
            });
        }

        let prompt = "fix it & echo PWNED | rm -rf nothing \"quoted\"";
        let started = start_agent_run(
            app.handle().clone(),
            app.state::<AgentState>(),
            work.to_string_lossy().to_string(),
            prompt.to_string(),
            None,
            None,
            Some("normal".into()),
        )
        .unwrap();

        let mut events = Vec::new();
        let mut stderr = String::new();
        let mut exit_code = None;
        while exit_code.is_none() {
            let (name, v) = rx.recv_timeout(std::time::Duration::from_secs(10)).expect("agent events");
            assert_eq!(v["runId"], started.run_id);
            match name.as_str() {
                "agent-event" => events.push(v["event"].clone()),
                "agent-stderr" => stderr.push_str(v["text"].as_str().unwrap()),
                _ => exit_code = v["code"].as_i64(),
            }
        }
        assert_eq!(exit_code, Some(3));
        assert_eq!(events[0]["session_id"], "s1");
        let cwd = std::fs::canonicalize(&work).unwrap();
        assert_eq!(std::fs::canonicalize(events[0]["cwd"].as_str().unwrap()).unwrap(), cwd);
        assert_eq!(std::fs::read_to_string(work.join("received_prompt.txt")).unwrap(), prompt);
        assert_eq!(events[1]["count"], 8);
        assert!(!work.join("PWNED").exists());
        assert_eq!(events[2], serde_json::Value::String("not json".into()));
        assert!(stderr.contains("warn line"));
        assert!(app.state::<AgentState>().runs.lock().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&bin);
        let _ = std::fs::remove_dir_all(&work);
    }

    #[test]
    fn autonomy_maps_to_cli_flags() {
        assert_eq!(permission_args("normal"), vec!["--permission-mode", "default"]);
        assert_eq!(permission_args("redline"), vec!["--permission-mode", "acceptEdits"]);
        assert_eq!(permission_args("yolo"), vec!["--dangerously-skip-permissions"]);
        assert_eq!(permission_args("anything"), vec!["--dangerously-skip-permissions"]);
    }
}
