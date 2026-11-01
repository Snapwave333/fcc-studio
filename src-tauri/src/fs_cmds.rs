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
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 4 * 1024 * 1024 {
        return Err("file too large to open in editor (>4 MB)".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.iter().take(8000).any(|b| *b == 0) {
        return Err("binary file".into());
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
    let tmp = parent.join(format!(".{file_name}.{}.fcc-tmp", std::process::id()));
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn create_dir(path: String) -> Result<(), String> {
    if Path::new(&path).exists() {
        return Err(format!("{path} already exists"));
    }
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
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            walk(&path, out, depth + 1);
        } else {
            out.push(path);
        }
    }
}

#[tauri::command]
pub async fn list_files(root: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = PathBuf::from(&root);
        if !base.is_dir() {
            return Err(format!("not a directory: {root}"));
        }
        let mut files = Vec::new();
        walk(&base, &mut files, 0);
        let mut rel: Vec<String> = files
            .into_iter()
            .filter_map(|p| p.strip_prefix(&base).ok().map(|r| r.to_string_lossy().replace('\\', "/")))
            .collect();
        rel.sort();
        Ok(rel)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub path: String,
    pub line: u64,
    pub text: String,
}

#[tauri::command]
pub async fn search_project(root: String, query: String, max_results: Option<u32>) -> Result<Vec<SearchHit>, String> {
    tauri::async_runtime::spawn_blocking(move || search_blocking(&root, &query, max_results))
        .await
        .map_err(|e| e.to_string())?
}

fn search_blocking(root: &str, query: &str, max_results: Option<u32>) -> Result<Vec<SearchHit>, String> {
    let needle = query.to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
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
        let Ok(bytes) = std::fs::read(&file) else { continue };
        if bytes.iter().take(8000).any(|b| *b == 0) {
            continue;
        }
        let Ok(content) = String::from_utf8(bytes) else { continue };
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
    crate::platform::open_path(&path)
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

#[derive(Default)]
pub struct FsWatchState {
    pub watcher: std::sync::Mutex<Option<(String, notify::RecommendedWatcher)>>,
}

fn noisy(path: &Path) -> bool {
    path.components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        matches!(s.as_ref(), ".git" | "node_modules" | "target" | "__pycache__" | ".next" | ".cache" | ".venv")
    }) || path.extension().map(|e| e == "fcc-tmp").unwrap_or(false)
}

#[tauri::command]
pub fn start_fs_watch(
    app: tauri::AppHandle,
    state: tauri::State<FsWatchState>,
    root: String,
) -> Result<(), String> {
    use notify::{RecursiveMode, Watcher};
    let mut guard = state.watcher.lock().map_err(|e| e.to_string())?;
    if guard.as_ref().map(|(r, _)| r == &root).unwrap_or(false) {
        return Ok(());
    }
    *guard = None;
    if !Path::new(&root).is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(tx).map_err(|e| e.to_string())?;
    watcher
        .watch(Path::new(&root), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    let root_evt = root.clone();
    std::thread::spawn(move || {
        use std::sync::mpsc::RecvTimeoutError;
        let collect = |ev: notify::Result<notify::Event>, acc: &mut std::collections::BTreeSet<String>| {
            if let Ok(ev) = ev {
                if matches!(ev.kind, notify::EventKind::Access(_)) {
                    return;
                }
                for p in ev.paths {
                    if !noisy(&p) && acc.len() < 200 {
                        acc.insert(p.to_string_lossy().to_string());
                    }
                }
            }
        };
        loop {
            match rx.recv_timeout(std::time::Duration::from_millis(500)) {
                Ok(first) => {
                    let mut paths = std::collections::BTreeSet::new();
                    collect(first, &mut paths);
                    loop {
                        match rx.recv_timeout(std::time::Duration::from_millis(250)) {
                            Ok(ev) => collect(ev, &mut paths),
                            Err(RecvTimeoutError::Timeout) => break,
                            Err(RecvTimeoutError::Disconnected) => return,
                        }
                    }
                    if !paths.is_empty() {
                        let _ = app.emit(
                            "fs-changed",
                            serde_json::json!({ "root": root_evt, "paths": paths.into_iter().collect::<Vec<_>>() }),
                        );
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
                Err(RecvTimeoutError::Timeout) => continue,
            }
        }
    });
    *guard = Some((root, watcher));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("serenity-fs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn atomic_write_then_read_round_trips() {
        let d = tmpdir();
        let f = d.join("nested").join("a.ts");
        write_file(f.to_string_lossy().to_string(), "const a = 1;\n".into()).unwrap();
        write_file(f.to_string_lossy().to_string(), "const a = 2;\n".into()).unwrap();
        assert_eq!(read_file(f.to_string_lossy().to_string()).unwrap(), "const a = 2;\n");
        let leftovers: Vec<_> = std::fs::read_dir(d.join("nested")).unwrap().flatten().collect();
        assert_eq!(leftovers.len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn binary_files_are_rejected() {
        let d = tmpdir();
        let f = d.join("x.bin");
        std::fs::write(&f, [0u8, 1, 2, 3]).unwrap();
        assert!(read_file(f.to_string_lossy().to_string()).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn search_skips_ignored_dirs_and_finds_hits() {
        let d = tmpdir();
        std::fs::create_dir_all(d.join("node_modules")).unwrap();
        std::fs::write(d.join("node_modules").join("dep.js"), "needle").unwrap();
        std::fs::write(d.join("main.ts"), "line one\nfind the NEEDLE here\n").unwrap();
        let hits = search_blocking(&d.to_string_lossy(), "needle", None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line, 2);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn list_dir_sorts_directories_first() {
        let d = tmpdir();
        std::fs::write(d.join("b.txt"), "").unwrap();
        std::fs::create_dir_all(d.join("z")).unwrap();
        let entries = list_dir(d.to_string_lossy().to_string(), String::new()).unwrap();
        assert!(entries[0].is_dir);
        assert_eq!(entries[1].name, "b.txt");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn list_files_returns_relative_sorted_paths() {
        let d = tmpdir();
        std::fs::create_dir_all(d.join("src").join("deep")).unwrap();
        std::fs::create_dir_all(d.join(".git")).unwrap();
        std::fs::write(d.join(".git").join("HEAD"), "").unwrap();
        std::fs::write(d.join("src").join("deep").join("b.ts"), "").unwrap();
        std::fs::write(d.join("a.md"), "").unwrap();
        let files = tauri::async_runtime::block_on(list_files(d.to_string_lossy().to_string())).unwrap();
        assert_eq!(files, vec!["a.md".to_string(), "src/deep/b.ts".to_string()]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn noisy_paths_are_filtered() {
        assert!(noisy(Path::new("/p/.git/index")));
        assert!(noisy(Path::new("/p/node_modules/x/y.js")));
        assert!(!noisy(Path::new("/p/src/app.tsx")));
    }
}
