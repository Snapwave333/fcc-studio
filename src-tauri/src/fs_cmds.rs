use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tauri::Emitter;

#[derive(Debug, Clone, Serialize)]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: f64,
}

fn system_time_to_secs(t: Option<SystemTime>) -> f64 {
    t.and_then(|st| st.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

#[tauri::command]
pub fn list_dir(root: String, rel: String) -> Result<Vec<FsEntry>, String> {
    let base = PathBuf::from(&root);
    let target = if rel.is_empty() {
        base.clone()
    } else {
        base.join(&rel)
    };
    if !target.is_dir() {
        return Err(format!("not a directory: {}", target.display()));
    }
    let mut entries: Vec<FsEntry> = Vec::new();
    for entry in std::fs::read_dir(&target).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        let full = entry.path();
        entries.push(FsEntry {
            path: full.to_string_lossy().to_string(),
            is_dir: meta.is_dir(),
            size: meta.len(),
            modified: system_time_to_secs(meta.modified().ok()),
            name,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("file too large to open in editor (>4 MB)".into());
    }
    String::from_utf8(bytes).map_err(|_| "binary file".into())
}

#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let parent = target
        .parent()
        .ok_or_else(|| "invalid path".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = target.with_extension("fcc-tmp");
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn create_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_path(from: String, to: String) -> Result<(), String> {
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(p).map_err(|e| e.to_string())
    }
}

fn is_ignored(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "dist" | "build" | "target" | ".venv" | "venv" | "__pycache__" | ".next" | ".cache"
    )
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 12 || out.len() > 20_000 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if is_ignored(&name) {
            continue;
        }
        if path.is_dir() {
            walk(&path, out, depth + 1);
        } else {
            out.push(path);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub path: String,
    pub line: u64,
    pub text: String,
}

#[tauri::command]
pub fn search_project(root: String, query: String, max_results: Option<u32>) -> Result<Vec<SearchHit>, String> {
    let needle = query.to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let cap = max_results.unwrap_or(300).min(2000) as usize;
    let mut files = Vec::new();
    walk(Path::new(&root), &mut files, 0);
    let mut hits = Vec::new();
    for file in files {
        if hits.len() >= cap {
            break;
        }
        let Ok(meta) = std::fs::metadata(&file) else { continue };
        if meta.len() > 1_500_000 {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&file) else { continue };
        for (i, line) in content.lines().enumerate() {
            if line.to_lowercase().contains(&needle) {
                hits.push(SearchHit {
                    path: file.to_string_lossy().to_string(),
                    line: (i + 1) as u64,
                    text: line.chars().take(240).collect(),
                });
                if hits.len() >= cap {
                    break;
                }
            }
        }
    }
    Ok(hits)
}

#[tauri::command]
pub fn open_in_explorer(path: String) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn pick_folder(title: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = rfd::AsyncFileDialog::new();
    if let Some(ref t) = title {
        dialog = dialog.set_title(t);
    }
    let res = dialog.pick_folder().await;
    Ok(res.map(|h| h.path().to_string_lossy().to_string()))
}

#[tauri::command]
pub fn start_fs_watch(app: tauri::AppHandle, root: String) -> Result<(), String> {
    use notify::{RecursiveMode, Watcher};
    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let Ok(mut watcher) = notify::recommended_watcher(tx) else {
            return;
        };
        if watcher.watch(Path::new(&root), RecursiveMode::Recursive).is_err() {
            return;
        }
        loop {
            match rx.recv_timeout(std::time::Duration::from_millis(400)) {
                Ok(_) => {
                    // drain the debounce window
                    while rx.recv_timeout(std::time::Duration::from_millis(300)).is_ok() {}
                    let _ = app.emit("fs-changed", serde_json::json!({ "root": root }));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            }
        }
    });
    Ok(())
}
