use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;
use tauri::Emitter;

use crate::proc;

#[derive(Default)]
pub struct WatchState {
    current: Mutex<Option<(String, Arc<AtomicBool>)>>,
}

impl WatchState {
    pub fn stop(&self) {
        if let Ok(mut guard) = self.current.lock() {
            if let Some((_, flag)) = guard.take() {
                flag.store(true, Ordering::SeqCst);
            }
        }
    }
}

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
    let file_name = target
        .file_name()
        .ok_or_else(|| "invalid path".to_string())?
        .to_string_lossy()
        .to_string();
    let tmp = parent.join(format!(".{file_name}.fcc-tmp"));
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| e.to_string())?;
    if let Ok(meta) = std::fs::metadata(&target) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

#[tauri::command]
pub fn create_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_path(from: String, to: String) -> Result<(), String> {
    if Path::new(&to).exists() {
        return Err(format!("{to} already exists"));
    }
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
            | ".turbo" | ".svelte-kit" | ".nuxt" | "coverage" | ".idea" | ".gradle" | "out"
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
        match entry.file_type() {
            Ok(ft) if ft.is_dir() => walk(&path, out, depth + 1),
            Ok(ft) if ft.is_file() => out.push(path),
            _ => {}
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
pub async fn search_project(root: String, query: String, max_results: Option<u32>) -> Result<Vec<SearchHit>, String> {
    proc::blocking(move || Ok(search(&root, &query, max_results))).await
}

pub fn search(root: &str, query: &str, max_results: Option<u32>) -> Vec<SearchHit> {
    let needle = query.to_lowercase();
    if needle.trim().is_empty() {
        return Vec::new();
    }
    let cap = max_results.unwrap_or(300).min(2000) as usize;
    let mut files = Vec::new();
    walk(Path::new(root), &mut files, 0);
    let mut hits = Vec::new();
    for file in files {
        if hits.len() >= cap {
            break;
        }
        let Ok(meta) = std::fs::metadata(&file) else { continue };
        if meta.len() > 1_500_000 {
            continue;
        }
        let file_name = file.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
        if file_name.contains(&needle) {
            hits.push(SearchHit {
                path: file.to_string_lossy().to_string(),
                line: 0,
                text: String::new(),
            });
            if hits.len() >= cap {
                break;
            }
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
    hits
}

#[tauri::command]
pub fn open_in_explorer(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err(format!("path does not exist: {path}"));
    }
    proc::open_path(&path).map_err(|e| e.to_string())
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

fn is_noise(path: &Path) -> bool {
    path.components().any(|c| match c {
        std::path::Component::Normal(n) => is_ignored(&n.to_string_lossy()),
        _ => false,
    }) || path.extension().map(|e| e == "fcc-tmp").unwrap_or(false)
}

#[tauri::command]
pub fn start_fs_watch(app: tauri::AppHandle, state: tauri::State<WatchState>, root: String) -> Result<(), String> {
    use notify::{RecursiveMode, Watcher};
    let stop = Arc::new(AtomicBool::new(false));
    {
        let mut guard = state.current.lock().map_err(|e| e.to_string())?;
        if let Some((current_root, _)) = guard.as_ref() {
            if *current_root == root {
                return Ok(());
            }
        }
        if let Some((_, flag)) = guard.take() {
            flag.store(true, Ordering::SeqCst);
        }
        *guard = Some((root.clone(), stop.clone()));
    }
    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
        let Ok(mut watcher) = notify::recommended_watcher(tx) else {
            return;
        };
        if watcher.watch(Path::new(&root), RecursiveMode::Recursive).is_err() {
            return;
        }
        let relevant = |ev: &notify::Result<notify::Event>| match ev {
            Ok(e) => e.paths.iter().any(|p| !is_noise(p)),
            Err(_) => false,
        };
        while !stop.load(Ordering::SeqCst) {
            match rx.recv_timeout(std::time::Duration::from_millis(400)) {
                Ok(ev) => {
                    let mut changed = relevant(&ev);
                    while let Ok(more) = rx.recv_timeout(std::time::Duration::from_millis(300)) {
                        changed |= relevant(&more);
                    }
                    if changed && !stop.load(Ordering::SeqCst) {
                        let _ = app.emit("fs-changed", serde_json::json!({ "root": root }));
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_finds_content_and_file_names_and_skips_ignored_dirs() {
        let root = std::env::temp_dir().join(format!("fcc-search-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::write(root.join("src/app.ts"), "const Needle = 1;\nother\n").unwrap();
        std::fs::write(root.join("src/needle.md"), "nothing").unwrap();
        std::fs::write(root.join("node_modules/pkg/index.js"), "needle").unwrap();
        let hits = search(&root.to_string_lossy(), "needle", None);
        assert!(hits.iter().any(|h| h.path.ends_with("app.ts") && h.line == 1));
        assert!(hits.iter().any(|h| h.path.ends_with("needle.md") && h.line == 0));
        assert!(!hits.iter().any(|h| h.path.contains("node_modules")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn write_file_is_atomic_and_creates_parents() {
        let root = std::env::temp_dir().join(format!("fcc-write-test-{}", uuid::Uuid::new_v4()));
        let target = root.join("a/b/c.txt");
        write_file(target.to_string_lossy().to_string(), "one".into()).unwrap();
        write_file(target.to_string_lossy().to_string(), "two".into()).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "two");
        assert_eq!(std::fs::read_dir(root.join("a/b")).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn noise_filter_ignores_build_dirs() {
        assert!(is_noise(Path::new("/p/node_modules/x.js")));
        assert!(is_noise(Path::new("/p/.git/index")));
        assert!(!is_noise(Path::new("/p/src/main.ts")));
    }
}
