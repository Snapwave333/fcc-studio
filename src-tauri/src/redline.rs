use serde::Serialize;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Emitter;

use crate::db::Db;
use crate::platform;

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

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

fn gpu_info() -> (String, f64, f64) {
    let out = platform::command("nvidia-smi")
        .args(["--query-gpu=name,memory.total,memory.used", "--format=csv,noheader,nounits"])
        .output();
    if let Ok(o) = out {
        if o.status.success() {
            let text = String::from_utf8_lossy(&o.stdout);
            if let Some(line) = text.lines().next() {
                let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
                if parts.len() >= 3 {
                    return (
                        parts[0].to_string(),
                        parts[1].parse::<f64>().unwrap_or(0.0) / 1024.0,
                        parts[2].parse::<f64>().unwrap_or(0.0) / 1024.0,
                    );
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(o) = platform::command("sysctl").args(["-n", "machdep.cpu.brand_string"]).output() {
            let name = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if name.contains("Apple") {
                return (format!("{name} (unified memory)"), 0.0, 0.0);
            }
        }
    }
    ("none".into(), 0.0, 0.0)
}

#[cfg_attr(not(all(unix, not(target_os = "macos"))), allow(dead_code))]
pub fn parse_meminfo(text: &str) -> (f64, f64) {
    let mut total = 0.0;
    let mut avail = 0.0;
    for line in text.lines() {
        let mut it = line.split_whitespace();
        let key = it.next().unwrap_or("");
        let kb: f64 = it.next().and_then(|v| v.parse().ok()).unwrap_or(0.0);
        match key {
            "MemTotal:" => total = kb / 1_048_576.0,
            "MemAvailable:" => avail = kb / 1_048_576.0,
            _ => {}
        }
    }
    (total, avail)
}

#[cfg_attr(windows, allow(dead_code))]
pub fn parse_df(text: &str) -> f64 {
    text.lines()
        .nth(1)
        .and_then(|l| l.split_whitespace().nth(3))
        .and_then(|v| v.parse::<f64>().ok())
        .map(|kb| kb / 1_048_576.0)
        .unwrap_or(0.0)
}

#[cfg_attr(windows, allow(dead_code))]
fn disk_free_unix() -> f64 {
    let target = platform::home_dir().unwrap_or_else(|| std::path::PathBuf::from("/"));
    platform::command("df")
        .args(["-Pk"])
        .arg(&target)
        .output()
        .map(|o| parse_df(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or(0.0)
}

fn memory() -> (f64, f64) {
    #[cfg(windows)]
    {
        let out = platform::command("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "$os = Get-CimInstance Win32_OperatingSystem; \"{0} {1}\" -f $os.TotalVisibleMemorySize, $os.FreePhysicalMemory",
            ])
            .output();
        if let Ok(o) = out {
            let text = String::from_utf8_lossy(&o.stdout).to_string();
            let parts: Vec<f64> = text.split_whitespace().filter_map(|v| v.parse().ok()).collect();
            if parts.len() >= 2 {
                return (parts[0] / 1_048_576.0, parts[1] / 1_048_576.0);
            }
        }
        (0.0, 0.0)
    }
    #[cfg(target_os = "macos")]
    {
        let total = platform::command("sysctl")
            .args(["-n", "hw.memsize"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<f64>().ok())
            .unwrap_or(0.0)
            / 1_073_741_824.0;
        let free = platform::command("vm_stat")
            .output()
            .ok()
            .map(|o| {
                let text = String::from_utf8_lossy(&o.stdout).to_string();
                let page = text
                    .lines()
                    .next()
                    .and_then(|l| l.split("page size of ").nth(1))
                    .and_then(|r| r.split_whitespace().next())
                    .and_then(|v| v.parse::<f64>().ok())
                    .unwrap_or(4096.0);
                let pages: f64 = text
                    .lines()
                    .filter(|l| l.starts_with("Pages free") || l.starts_with("Pages inactive") || l.starts_with("Pages speculative"))
                    .filter_map(|l| l.split(':').nth(1))
                    .filter_map(|v| v.trim().trim_end_matches('.').parse::<f64>().ok())
                    .sum();
                pages * page / 1_073_741_824.0
            })
            .unwrap_or(0.0);
        (total, free)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::fs::read_to_string("/proc/meminfo")
            .map(|t| parse_meminfo(&t))
            .unwrap_or((0.0, 0.0))
    }
}

fn disk_free() -> f64 {
    #[cfg(windows)]
    {
        platform::command("powershell")
            .args(["-NoProfile", "-Command", "(Get-PSDrive ($env:SystemDrive.TrimEnd(':'))).Free"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<f64>().ok())
            .map(|b| b / 1_073_741_824.0)
            .unwrap_or(0.0)
    }
    #[cfg(not(windows))]
    {
        disk_free_unix()
    }
}

fn hardware() -> Option<Hardware> {
    let (ram_total, ram_free) = memory();
    let (gpu, vram_total, vram_used) = gpu_info();
    Some(Hardware {
        gpu,
        vram_total_gb: round1(vram_total),
        vram_used_gb: round1(vram_used),
        ram_total_gb: round1(ram_total),
        ram_free_gb: round1(ram_free),
        disk_free_gb: round1(disk_free()),
    })
}

#[tauri::command]
pub async fn redline_status(state: tauri::State<'_, RedlineState>) -> Result<RedlineStatus, String> {
    let active = state.active_model.lock().map_err(|e| e.to_string())?.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let hw = std::thread::spawn(hardware);
        let (ollama_up, models) = ollama_models();
        let proxy_up = fcc_admin_get("/health").is_ok();
        let proxy_model = if proxy_up { current_model_ref().ok().flatten() } else { None };
        RedlineStatus {
            proxy_up,
            proxy_model,
            redline_active: active.is_some(),
            redline_model: active,
            ollama_up,
            lmstudio_up: lmstudio_up(),
            models,
            hardware: hw.join().ok().flatten(),
        }
    })
    .await
    .map_err(|e| e.to_string())
}

impl RedlineState {
    pub fn restore(db: &Db) -> Self {
        let active = db
            .0
            .lock()
            .ok()
            .and_then(|c| {
                c.query_row("SELECT value FROM kv WHERE key='redline.active'", [], |r| r.get::<_, String>(0))
                    .ok()
            })
            .filter(|v| !v.is_empty());
        RedlineState { active_model: Mutex::new(active) }
    }
}

fn kv_put(db: &Db, key: &str, value: &str) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO kv(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value=?2",
        rusqlite::params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn redline_activate(state: tauri::State<'_, RedlineState>, db: tauri::State<'_, Db>, model: String) -> Result<(), String> {
    let db = db.inner().clone();
    let already = state.active_model.lock().map_err(|e| e.to_string())?.is_some();
    let model_c = model.clone();
    tauri::async_runtime::spawn_blocking(move || activate_blocking(&db, &model_c, already))
        .await
        .map_err(|e| e.to_string())??;
    *state.active_model.lock().map_err(|e| e.to_string())? = Some(model);
    Ok(())
}

fn activate_blocking(db: &Db, model: &str, already_active: bool) -> Result<(), String> {
    if model.trim().is_empty() {
        return Err("no local model selected".into());
    }
    let (ollama_up, models) = ollama_models();
    if !ollama_up {
        return Err("Ollama is not running on 127.0.0.1:11434".into());
    }
    if !models.iter().any(|m| m.name == model) {
        return Err(format!("model '{model}' is not installed in Ollama"));
    }
    if !already_active {
        let backup = json!({
            "model": current_model_ref()?,
            "fallbacks": current_fallbacks()?,
        });
        kv_put(db, "redline.backup", &backup.to_string())?;
    }

    fcc_admin_apply(&json!({
        "MODEL": format!("ollama/{model}"),
        "MODEL_FALLBACKS": "",
    }))?;
    kv_put(db, "redline.active", model)?;
    kv_put(db, "redline.model", model)?;
    Ok(())
}

#[tauri::command]
pub async fn redline_deactivate(state: tauri::State<'_, RedlineState>, db: tauri::State<'_, Db>) -> Result<(), String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || deactivate_blocking(&db))
        .await
        .map_err(|e| e.to_string())??;
    *state.active_model.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

fn deactivate_blocking(db: &Db) -> Result<(), String> {
    let backup: Option<String> = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.query_row("SELECT value FROM kv WHERE key='redline.backup'", [], |r| r.get(0))
            .ok()
    };
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
            fcc_admin_apply(&serde_json::Value::Object(values))
                .map_err(|e| format!("could not restore previous model config: {e}"))?;
        }
    }
    kv_put(db, "redline.active", "")?;
    Ok(())
}

#[tauri::command]
pub fn redline_install_ollama() -> Result<String, String> {
    if cfg!(windows) {
        if platform::which("winget").is_none() {
            platform::open_url("https://ollama.com/download/windows")?;
            return Ok("winget not found; opened the Ollama download page".into());
        }
        platform::command("winget")
            .args([
                "install",
                "--id",
                "Ollama.Ollama",
                "-e",
                "--accept-source-agreements",
                "--accept-package-agreements",
            ])
            .spawn()
            .map_err(|e| format!("could not launch winget: {e}"))?;
        return Ok("Ollama installer launched via winget".into());
    }
    if cfg!(target_os = "macos") && platform::which("brew").is_some() {
        platform::command("brew")
            .args(["install", "ollama"])
            .spawn()
            .map_err(|e| format!("could not launch brew: {e}"))?;
        return Ok("Installing Ollama via Homebrew".into());
    }
    let page = if cfg!(target_os = "macos") {
        "https://ollama.com/download/mac"
    } else {
        "https://ollama.com/download/linux"
    };
    platform::open_url(page)?;
    Ok("Opened the official Ollama download page".into())
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

type BenchTask = fn(&str) -> TaskResult;

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
                detail: if ok { "valid structured tool call".into() } else { format!("got: {}", content.chars().take(160).collect::<String>()) },
            }
        }
        Err(e) => TaskResult { task: "strict_json_tool_call", score: 0.0, max: 25.0, latency_ms: 0, tokens: 0, detail: e },
    }
}

fn run_task_code_fix(model: &str) -> TaskResult {
    let prompt = "Fix this JavaScript function so it returns the sum of squares of 1..n inclusive. Return ONLY the corrected function, no markdown.\n\nfunction sumSquares(n) {\n  let s = 0;\n  for (let i = 1; i < n; i++) s += i * i;\n  return s;\n}";
    match ollama_chat(model, prompt, 120) {
        Ok((content, latency, tokens)) => {
            let code = extract_code(&content);
            let test_src = format!(
                "{}\n\nconst assert = require('assert');\ntry {{ assert.strictEqual(sumSquares(3), 14); assert.strictEqual(sumSquares(1), 1); console.log('PASS'); }} catch (e) {{ console.log('FAIL ' + e.message); }}",
                code
            );
            let dir = std::env::temp_dir().join(format!("fcc-bench-{}", uuid::Uuid::new_v4()));
            let _ = std::fs::create_dir_all(&dir);
            let file = dir.join("test.js");
            let pass = std::fs::write(&file, test_src)
                .ok()
                .and_then(|_| {
                    platform::command("node").arg(&file).output().ok()
                })
                .map(|o| String::from_utf8_lossy(&o.stdout).contains("PASS"))
                .unwrap_or(false);
            let _ = std::fs::remove_dir_all(&dir);
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
    finished: bool,
    index: usize,
    total: usize,
    score: f64,
    max: f64,
    latency_ms: u64,
    detail: String,
}

#[tauri::command]
pub async fn redline_benchmark_start(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    model: String,
) -> Result<(), String> {
    if BENCH_RUNNING.swap(true, Ordering::SeqCst) {
        return Err("a benchmark is already running".into());
    }
    let (ollama_up, models) = tauri::async_runtime::spawn_blocking(ollama_models)
        .await
        .map_err(|e| e.to_string())?;
    if !ollama_up || !models.iter().any(|m| m.name == model) {
        BENCH_RUNNING.store(false, Ordering::SeqCst);
        return Err(format!("model '{model}' is not available in the local engine"));
    }
    let db_inner = db.inner().clone();
    std::thread::spawn(move || {
        let db = db_inner;
        let tasks: [(&str, BenchTask); 4] = [
            ("strict_json_tool_call", run_task_strict_json),
            ("code_fix_and_verify", run_task_code_fix),
            ("instruction_adherence", run_task_instruction),
            ("repo_bug_analysis", run_task_repo_analysis),
        ];
        let total = tasks.len();
        let mut earned = 0.0;
        let mut possible = 0.0;
        for (i, (name, task)) in tasks.iter().enumerate() {
            let _ = app.emit(
                "redline-bench",
                BenchProgress {
                    model: model.clone(),
                    task: name.to_string(),
                    done: false,
                    finished: false,
                    index: i,
                    total,
                    score: 0.0,
                    max: 0.0,
                    latency_ms: 0,
                    detail: "running".into(),
                },
            );
            let r = task(&model);
            earned += r.score;
            possible += r.max;
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
                    finished: i + 1 == total,
                    index: i,
                    total,
                    score: r.score,
                    max: r.max,
                    latency_ms: r.latency_ms,
                    detail: r.detail.clone(),
                },
            );
        }
        let _ = app.emit(
            "redline-bench-done",
            json!({ "model": model, "score": earned, "max": possible }),
        );
        BENCH_RUNNING.store(false, Ordering::SeqCst);
    });
    Ok(())
}

pub fn extract_code(content: &str) -> String {
    if let Some(start) = content.find("```") {
        let after = &content[start + 3..];
        let body_start = after.find('\n').map(|i| i + 1).unwrap_or(0);
        let body = &after[body_start..];
        if let Some(end) = body.find("```") {
            return body[..end].to_string();
        }
        return body.to_string();
    }
    content.to_string()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_nested_config_values() {
        let cfg = json!({ "sections": [{ "fields": [{ "key": "MODEL", "value": "anthropic/x" }, { "key": "MODEL_FALLBACKS", "value": null }] }] });
        assert_eq!(find_field_value(&cfg, "MODEL"), Some(json!("anthropic/x")));
        assert_eq!(find_field_value(&cfg, "MODEL_FALLBACKS"), Some(serde_json::Value::Null));
        assert_eq!(find_field_value(&cfg, "NOPE"), None);
    }

    #[test]
    fn extracts_fenced_code() {
        let reply = "Here you go:\n```javascript\nfunction f() { return 1; }\n```\nDone.";
        assert_eq!(extract_code(reply).trim(), "function f() { return 1; }");
        assert_eq!(extract_code("function g() {}"), "function g() {}");
    }

    #[test]
    fn parses_linux_meminfo_and_df() {
        let (total, avail) = parse_meminfo("MemTotal:       16384000 kB\nMemFree: 1 kB\nMemAvailable:    8192000 kB\n");
        assert!((total - 15.625).abs() < 0.01);
        assert!((avail - 7.8125).abs() < 0.01);
        let free = parse_df("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 50 10485760 50% /\n");
        assert!((free - 10.0).abs() < 0.01);
    }

    #[test]
    fn url_encoding_is_safe_for_model_tags() {
        assert_eq!(urlencode("qwen2.5-coder:7b"), "qwen2.5-coder%3A7b");
    }
}
