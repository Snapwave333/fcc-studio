use serde::Serialize;
use serde_json::json;
use std::os::windows::process::CommandExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Emitter;

use crate::db::Db;

const OLLAMA_URL: &str = "http://127.0.0.1:11434";
const PROXY_PORT: u16 = 8082;

static BENCH_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Default)]
pub struct RedlineState {
    pub active_model: Mutex<Option<String>>,
}

fn http_get(url: &str, timeout: u64) -> Result<serde_json::Value, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(timeout))
        .build();
    let resp = agent
        .get(url)
        .call()
        .map_err(|e| format!("GET {url}: {e}"))?;
    resp.into_json::<serde_json::Value>()
        .map_err(|e| format!("bad JSON from {url}: {e}"))
}

fn http_post_json(url: &str, body: &serde_json::Value, timeout: u64) -> Result<serde_json::Value, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(timeout))
        .build();
    let resp = agent
        .post(url)
        .set("Content-Type", "application/json")
        .send_json(body.clone())
        .map_err(|e| format!("POST {url}: {e}"))?;
    resp.into_json::<serde_json::Value>()
        .map_err(|e| format!("bad JSON from {url}: {e}"))
}

fn fcc_admin_get(path: &str) -> Result<serde_json::Value, String> {
    http_get(&format!("http://127.0.0.1:{PROXY_PORT}{path}"), 5)
}

fn fcc_admin_apply(values: &serde_json::Value) -> Result<serde_json::Value, String> {
    http_post_json(
        &format!("http://127.0.0.1:{PROXY_PORT}/admin/api/config/apply"),
        &json!({ "values": values }),
        10,
    )
}

/// Recursively find the field descriptor with key == wanted_key and return its "value".
fn find_field_value(node: &serde_json::Value, wanted_key: &str) -> Option<serde_json::Value> {
    match node {
        serde_json::Value::Object(map) => {
            if map.get("key").and_then(|k| k.as_str()) == Some(wanted_key) {
                return map.get("value").cloned();
            }
            for v in map.values() {
                if let Some(found) = find_field_value(v, wanted_key) {
                    return Some(found);
                }
            }
            None
        }
        serde_json::Value::Array(items) => {
            for v in items {
                if let Some(found) = find_field_value(v, wanted_key) {
                    return Some(found);
                }
            }
            None
        }
        _ => None,
    }
}

fn current_model_ref() -> Result<Option<String>, String> {
    let cfg = fcc_admin_get("/admin/api/config")?;
    Ok(find_field_value(&cfg, "MODEL").and_then(|v| v.as_str().map(|s| s.to_string())))
}

fn current_fallbacks() -> Result<Option<String>, String> {
    let cfg = fcc_admin_get("/admin/api/config")?;
    Ok(find_field_value(&cfg, "MODEL_FALLBACKS")
        .map(|v| match &v {
            serde_json::Value::Null => String::new(),
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string(),
        }))
}

#[derive(Debug, Clone, Serialize)]
pub struct OllamaModel {
    pub name: String,
    pub size_gb: f64,
    pub family: String,
    pub quantization: String,
    pub parameter_size: String,
    pub context_length: u64,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Hardware {
    pub gpu: String,
    pub vram_total_gb: f64,
    pub vram_used_gb: f64,
    pub ram_total_gb: f64,
    pub ram_free_gb: f64,
    pub disk_free_gb: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RedlineStatus {
    pub proxy_up: bool,
    pub proxy_model: Option<String>,
    pub redline_active: bool,
    pub redline_model: Option<String>,
    pub ollama_up: bool,
    pub lmstudio_up: bool,
    pub models: Vec<OllamaModel>,
    pub hardware: Option<Hardware>,
}

fn ollama_models() -> (bool, Vec<OllamaModel>) {
    let tags = match http_get(&format!("{OLLAMA_URL}/api/tags"), 4) {
        Ok(v) => v,
        Err(_) => return (false, Vec::new()),
    };
    let mut models = Vec::new();
    if let Some(list) = tags.get("models").and_then(|m| m.as_array()) {
        for m in list {
            let name = m.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
            if name.is_empty() {
                continue;
            }
            let size_gb = m.get("size").and_then(|s| s.as_f64()).unwrap_or(0.0) / 1_073_741_824.0;
            let details = m.get("details");
            let mut context_length = 0u64;
            let mut capabilities: Vec<String> = m
                .get("capability")
                .and_then(|c| c.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default();
            if let Ok(show) = http_get(&format!("{OLLAMA_URL}/api/show?model={}", urlencode(&name)), 5) {
                if let Some(info) = show.get("model_info").and_then(|i| i.as_object()) {
                    for (k, v) in info {
                        if k.ends_with(".context_length") {
                            context_length = v.as_u64().unwrap_or(0);
                        }
                    }
                }
                if let Some(caps) = show.get("capabilities").and_then(|c| c.as_array()) {
                    for c in caps {
                        if let Some(s) = c.as_str() {
                            if !capabilities.contains(&s.to_string()) {
                                capabilities.push(s.to_string());
                            }
                        }
                    }
                }
            }
            models.push(OllamaModel {
                name,
                size_gb: (size_gb * 10.0).round() / 10.0,
                family: details
                    .and_then(|d| d.get("family"))
                    .and_then(|f| f.as_str())
                    .unwrap_or("")
                    .to_string(),
                quantization: details
                    .and_then(|d| d.get("quantization_level"))
                    .and_then(|q| q.as_str())
                    .unwrap_or("")
                    .to_string(),
                parameter_size: details
                    .and_then(|d| d.get("parameter_size"))
                    .and_then(|p| p.as_str())
                    .unwrap_or("")
                    .to_string(),
                context_length,
                capabilities,
            });
        }
    }
    (true, models)
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn lmstudio_up() -> bool {
    std::net::TcpStream::connect_timeout(
        &"127.0.0.1:1234".parse().unwrap(),
        Duration::from_millis(400),
    )
    .is_ok()
}

fn hardware() -> Option<Hardware> {
    let out = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "$os = Get-CimInstance Win32_OperatingSystem; \
             $d = Get-PSDrive C; \
             \"RAM {0} {1}\" -f [math]::Round($os.TotalVisibleMemorySize/1MB,1), [math]::Round($os.FreePhysicalMemory/1MB,1); \
             \"DISK {0}\" -f [math]::Round($d.Free/1GB,1); \
             $g = & nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv,noheader,nounits 2>$null; \
             if ($g) { \"GPU $g\" } else { \"GPU none\" }",
        ])
        .creation_flags(0x0800_0000)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let mut ram_total = 0.0;
    let mut ram_free = 0.0;
    let mut disk_free = 0.0;
    let mut gpu = String::from("none");
    let mut vram_total = 0.0;
    let mut vram_used = 0.0;
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("RAM ") {
            let parts: Vec<&str> = rest.split_whitespace().collect();
            if parts.len() >= 2 {
                ram_total = parts[0].parse().unwrap_or(0.0);
                ram_free = parts[1].parse().unwrap_or(0.0);
            }
        } else if let Some(rest) = line.strip_prefix("DISK ") {
            disk_free = rest.trim().parse().unwrap_or(0.0);
        } else if let Some(rest) = line.strip_prefix("GPU ") {
            let parts: Vec<&str> = rest.split(',').map(|s| s.trim()).collect();
            if parts.len() >= 3 {
                gpu = parts[0].to_string();
                vram_total = parts[1].parse::<f64>().unwrap_or(0.0) / 1024.0;
                vram_used = parts[2].parse::<f64>().unwrap_or(0.0) / 1024.0;
            }
        }
    }
    Some(Hardware {
        gpu,
        vram_total_gb: (vram_total * 10.0).round() / 10.0,
        vram_used_gb: (vram_used * 10.0).round() / 10.0,
        ram_total_gb: ram_total,
        ram_free_gb: ram_free,
        disk_free_gb: disk_free,
    })
}

#[tauri::command]
pub fn redline_status(state: tauri::State<RedlineState>) -> Result<RedlineStatus, String> {
    let (ollama_up, models) = ollama_models();
    let proxy_model = current_model_ref().ok().flatten();
    Ok(RedlineStatus {
        proxy_up: fcc_admin_get("/health").is_ok(),
        proxy_model,
        redline_active: state.active_model.lock().map_err(|e| e.to_string())?.is_some(),
        redline_model: state.active_model.lock().map_err(|e| e.to_string())?.clone(),
        ollama_up,
        lmstudio_up: lmstudio_up(),
        models,
        hardware: hardware(),
    })
}

#[tauri::command]
pub fn redline_activate(state: tauri::State<RedlineState>, db: tauri::State<Db>, model: String) -> Result<(), String> {
    let backup = json!({
        "model": current_model_ref()?,
        "fallbacks": current_fallbacks()?,
    });
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO kv(key, value) VALUES('redline.backup', ?1) ON CONFLICT(key) DO UPDATE SET value=?1",
        rusqlite::params![backup.to_string()],
    )
    .map_err(|e| e.to_string())?;
    drop(conn);

    // ACTIVE mode: local-only. Point MODEL at ollama and clear cloud fallbacks.
    fcc_admin_apply(&json!({
        "MODEL": format!("ollama/{model}"),
        "MODEL_FALLBACKS": "",
    }))?;

    *state.active_model.lock().map_err(|e| e.to_string())? = Some(model);
    Ok(())
}

#[tauri::command]
pub fn redline_deactivate(state: tauri::State<RedlineState>, db: tauri::State<Db>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let backup: Option<String> = conn
        .query_row("SELECT value FROM kv WHERE key='redline.backup'", [], |r| r.get(0))
        .ok();
    drop(conn);
    if let Some(raw) = backup {
        if let Ok(backup) = serde_json::from_str::<serde_json::Value>(&raw) {
            let mut values = serde_json::Map::new();
            values.insert(
                "MODEL".into(),
                backup.get("model").cloned().unwrap_or(serde_json::Value::Null),
            );
            values.insert(
                "MODEL_FALLBACKS".into(),
                backup.get("fallbacks").cloned().unwrap_or(serde_json::Value::Null),
            );
            let _ = fcc_admin_apply(&serde_json::Value::Object(values));
        }
    }
    *state.active_model.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

#[tauri::command]
pub fn redline_install_ollama() -> Result<(), String> {
    std::process::Command::new("winget")
        .args([
            "install",
            "--id",
            "Ollama.Ollama",
            "-e",
            "--accept-source-agreements",
            "--accept-package-agreements",
        ])
        .creation_flags(0x0800_0000)
        .spawn()
        .map_err(|e| format!("could not launch winget: {e} (is winget installed?)"))?;
    Ok(())
}

fn record_benchmark(db: &Db, model: &str, task: &str, score: f64, latency_ms: u64, tokens: u64, detail: &str) {
    let conn = match db.0.lock() {
        Ok(c) => c,
        Err(_) => return,
    };
    let _ = conn.execute(
        "INSERT INTO benchmarks(model, task, score, latency_ms, tokens, detail, created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        rusqlite::params![model, task, score, latency_ms as i64, tokens as i64, detail, chrono::Utc::now().to_rfc3339()],
    );
}

fn ollama_chat(model: &str, prompt: &str, timeout: u64) -> Result<(String, u64, u64), String> {
    let started = Instant::now();
    let resp = http_post_json(
        &format!("{OLLAMA_URL}/api/chat"),
        &json!({
            "model": model,
            "messages": [{ "role": "user", "content": prompt }],
            "stream": false,
            "options": { "temperature": 0 }
        }),
        timeout,
    )?;
    let latency = started.elapsed().as_millis() as u64;
    let content = resp
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    let tokens = resp.get("eval_count").and_then(|t| t.as_u64()).unwrap_or(0);
    if content.is_empty() {
        return Err("empty response".into());
    }
    Ok((content, latency, tokens))
}

struct TaskResult {
    task: &'static str,
    score: f64,
    max: f64,
    latency_ms: u64,
    tokens: u64,
    detail: String,
}

fn run_task_strict_json(model: &str) -> TaskResult {
    let prompt = "Return ONLY a JSON object, no other text, exactly in this shape: {\"tool\": \"write_file\", \"args\": {\"path\": \"src/app.ts\", \"lines\": 12}}";
    match ollama_chat(model, prompt, 90) {
        Ok((content, latency, tokens)) => {
            let trimmed = content.trim();
            let json_str = trimmed
                .find('{')
                .and_then(|s| trimmed.rfind('}').map(|e| &trimmed[s..=e]))
                .unwrap_or(trimmed);
            let ok = serde_json::from_str::<serde_json::Value>(json_str)
                .ok()
                .map(|v| {
                    v.get("tool").and_then(|t| t.as_str()) == Some("write_file")
                        && v.get("args").and_then(|a| a.get("path")).and_then(|p| p.as_str()) == Some("src/app.ts")
                        && v.get("args").and_then(|a| a.get("lines")).and_then(|l| l.as_u64()) == Some(12)
                })
                .unwrap_or(false);
            TaskResult {
                task: "strict_json_tool_call",
                score: if ok { 25.0 } else { 0.0 },
                max: 25.0,
                latency_ms: latency,
                tokens,
                detail: if ok { "valid structured tool call".into() } else { format!("got: {}", &content.chars().take(160).collect::<String>()) },
            }
        }
        Err(e) => TaskResult { task: "strict_json_tool_call", score: 0.0, max: 25.0, latency_ms: 0, tokens: 0, detail: e },
    }
}

fn run_task_code_fix(model: &str) -> TaskResult {
    let prompt = "Fix this JavaScript function so it returns the sum of squares of 1..n inclusive. Return ONLY the corrected function, no markdown.\n\nfunction sumSquares(n) {\n  let s = 0;\n  for (let i = 1; i < n; i++) s += i * i;\n  return s;\n}";
    match ollama_chat(model, prompt, 120) {
        Ok((content, latency, tokens)) => {
            let code = content
                .replace("```javascript", "")
                .replace("```js", "")
                .replace("```", "");
            let test_src = format!(
                "{}\n\nconst assert = require('assert');\ntry {{ assert.strictEqual(sumSquares(3), 14); assert.strictEqual(sumSquares(1), 1); console.log('PASS'); }} catch (e) {{ console.log('FAIL ' + e.message); }}",
                code
            );
            let dir = std::env::temp_dir().join(format!("fcc-bench-{}", std::process::id()));
            let _ = std::fs::create_dir_all(&dir);
            let file = dir.join("test.js");
            let pass = std::fs::write(&file, test_src)
                .ok()
                .and_then(|_| {
                    std::process::Command::new("node")
                        .arg(&file)
                        .creation_flags(0x0800_0000)
                        .output()
                        .ok()
                })
                .map(|o| String::from_utf8_lossy(&o.stdout).contains("PASS"))
                .unwrap_or(false);
            TaskResult {
                task: "code_fix_and_verify",
                score: if pass { 30.0 } else { 0.0 },
                max: 30.0,
                latency_ms: latency,
                tokens,
                detail: if pass { "corrected code passes tests".into() } else { "corrected code failed verification".into() },
            }
        }
        Err(e) => TaskResult { task: "code_fix_and_verify", score: 0.0, max: 30.0, latency_ms: 0, tokens: 0, detail: e },
    }
}

fn run_task_instruction(model: &str) -> TaskResult {
    let prompt = "Reply with exactly three lines and nothing else:\nLine 1: STEP\nLine 2: BUILD\nLine 3: TEST";
    match ollama_chat(model, prompt, 60) {
        Ok((content, latency, tokens)) => {
            let lines: Vec<&str> = content.trim().lines().map(|l| l.trim()).collect();
            let ok = lines.len() == 3 && lines[0] == "STEP" && lines[1] == "BUILD" && lines[2] == "TEST";
            TaskResult {
                task: "instruction_adherence",
                score: if ok { 20.0 } else if lines.len() == 3 { 8.0 } else { 0.0 },
                max: 20.0,
                latency_ms: latency,
                tokens,
                detail: format!("{} lines", lines.len()),
            }
        }
        Err(e) => TaskResult { task: "instruction_adherence", score: 0.0, max: 20.0, latency_ms: 0, tokens: 0, detail: e },
    }
}

fn run_task_repo_analysis(model: &str) -> TaskResult {
    let prompt = "A parser mishandles the last item in a list. Study this loop and name the exact off-by-one bug in one short sentence:\n\nfor (let i = 0; i < items.length - 1; i++) {\n  parse(items[i]);\n}";
    match ollama_chat(model, prompt, 90) {
        Ok((content, latency, tokens)) => {
            let lower = content.to_lowercase();
            let ok = lower.contains("length - 1") || lower.contains("off-by-one") || lower.contains("off by one");
            TaskResult {
                task: "repo_bug_analysis",
                score: if ok { 25.0 } else { 0.0 },
                max: 25.0,
                latency_ms: latency,
                tokens,
                detail: content.chars().take(160).collect(),
            }
        }
        Err(e) => TaskResult { task: "repo_bug_analysis", score: 0.0, max: 25.0, latency_ms: 0, tokens: 0, detail: e },
    }
}

#[derive(Clone, Serialize)]
struct BenchProgress {
    model: String,
    task: String,
    done: bool,
    score: f64,
    max: f64,
    latency_ms: u64,
    detail: String,
}

#[tauri::command]
pub fn redline_benchmark_start(
    app: tauri::AppHandle,
    db: tauri::State<Db>,
    model: String,
) -> Result<(), String> {
    if BENCH_RUNNING.swap(true, Ordering::SeqCst) {
        return Err("a benchmark is already running".into());
    }
    let (ollama_up, models) = ollama_models();
    if !ollama_up || !models.iter().any(|m| m.name == model) {
        BENCH_RUNNING.store(false, Ordering::SeqCst);
        return Err(format!("model '{model}' is not available in the local engine"));
    }
    let db_inner = db.inner().clone();
    std::thread::spawn(move || {
        let db = db_inner;
        let results = vec![
            run_task_strict_json(&model),
            run_task_code_fix(&model),
            run_task_instruction(&model),
            run_task_repo_analysis(&model),
        ];
        for r in &results {
            record_benchmark(
                &db,
                &model,
                r.task,
                r.score,
                r.latency_ms,
                r.tokens,
                &format!("score {}/{} — {}", r.score, r.max, r.detail),
            );
            let _ = app.emit(
                "redline-bench",
                BenchProgress {
                    model: model.clone(),
                    task: r.task.to_string(),
                    done: true,
                    score: r.score,
                    max: r.max,
                    latency_ms: r.latency_ms,
                    detail: r.detail.clone(),
                },
            );
        }
        BENCH_RUNNING.store(false, Ordering::SeqCst);
    });
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct LeaderboardRow {
    pub model: String,
    pub avg_score: f64,
    pub tasks_run: i64,
    pub avg_latency_ms: i64,
    pub last_run: String,
}

#[tauri::command]
pub fn redline_leaderboard(db: tauri::State<Db>) -> Result<Vec<LeaderboardRow>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT model, AVG(score), COUNT(*), AVG(latency_ms), MAX(created_at) \
             FROM benchmarks GROUP BY model ORDER BY AVG(score) DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(LeaderboardRow {
                model: r.get(0)?,
                avg_score: r.get::<_, f64>(1)?,
                tasks_run: r.get(2)?,
                avg_latency_ms: r.get::<_, f64>(3)? as i64,
                last_run: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
pub fn redline_bench_running() -> Result<bool, String> {
    Ok(BENCH_RUNNING.load(Ordering::SeqCst))
}
