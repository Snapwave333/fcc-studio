use serde::Serialize;

use crate::proc;

fn git_output(dir: &str, args: &[&str]) -> Result<std::process::Output, String> {
    proc::command("git")
        .current_dir(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("git not available: {e}"))
}

fn git(dir: &str, args: &[&str]) -> Result<String, String> {
    let output = git_output(dir, args)?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn has_head(dir: &str) -> bool {
    git(dir, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok()
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct StatusEntry {
    pub path: String,
    pub x: String,
    pub y: String,
    pub staged: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GitStatus {
    pub repo: bool,
    pub branch: String,
    pub upstream: String,
    pub ahead: i32,
    pub behind: i32,
    pub entries: Vec<StatusEntry>,
}

const MAX_STATUS_ENTRIES: usize = 2000;

fn unquote(path: &str) -> String {
    let p = path.trim();
    if p.len() >= 2 && p.starts_with('"') && p.ends_with('"') {
        p[1..p.len() - 1].replace("\\\"", "\"").replace("\\\\", "\\")
    } else {
        p.to_string()
    }
}

pub fn parse_branch_line(rest: &str) -> (String, String, i32, i32) {
    let (head, tracking) = match rest.find(" [") {
        Some(i) => (&rest[..i], Some(rest[i + 2..].trim_end_matches(']'))),
        None => (rest, None),
    };
    let (branch, upstream) = match head.split_once("...") {
        Some((b, u)) => (b.to_string(), u.to_string()),
        None => (head.to_string(), String::new()),
    };
    let branch = if let Some(b) = branch.strip_prefix("No commits yet on ") {
        b.to_string()
    } else if branch.starts_with("HEAD (no branch)") || branch.is_empty() {
        "HEAD".to_string()
    } else {
        branch
    };
    let mut ahead = 0;
    let mut behind = 0;
    if let Some(t) = tracking {
        for part in t.split(',') {
            let part = part.trim();
            if let Some(n) = part.strip_prefix("ahead ") {
                ahead = n.trim().parse().unwrap_or(0);
            } else if let Some(n) = part.strip_prefix("behind ") {
                behind = n.trim().parse().unwrap_or(0);
            }
        }
    }
    (branch, upstream, ahead, behind)
}

pub fn parse_status(out: &str) -> GitStatus {
    let mut status = GitStatus {
        repo: true,
        branch: String::new(),
        upstream: String::new(),
        ahead: 0,
        behind: 0,
        entries: Vec::new(),
    };
    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            let (branch, upstream, ahead, behind) = parse_branch_line(rest);
            status.branch = branch;
            status.upstream = upstream;
            status.ahead = ahead;
            status.behind = behind;
        } else if line.len() >= 4 && line.is_char_boundary(3) {
            let x = line[0..1].to_string();
            let y = line[1..2].to_string();
            let raw = &line[3..];
            let path = match raw.rsplit_once(" -> ") {
                Some((_, to)) if x == "R" || x == "C" => unquote(to),
                _ => unquote(raw),
            };
            status.entries.push(StatusEntry {
                path,
                staged: x != " " && x != "?",
                x,
                y,
            });
        }
    }
    status
}

#[tauri::command]
pub async fn git_status(root: String) -> Result<GitStatus, String> {
    tauri::async_runtime::spawn_blocking(move || match git(&root, &["-c", "core.quotepath=off", "status", "--porcelain=v1", "-b", "-uall"]) {
        Ok(out) => {
            let mut st = parse_status(&out);
            st.entries.truncate(MAX_STATUS_ENTRIES);
            st
        }
        Err(_) => GitStatus {
            repo: false,
            branch: String::new(),
            upstream: String::new(),
            ahead: 0,
            behind: 0,
            entries: Vec::new(),
        },
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
pub struct CommitInfo {
    pub hash: String,
    pub author: String,
    pub date: String,
    pub subject: String,
}

#[tauri::command]
pub async fn git_log(root: String, limit: Option<u32>) -> Result<Vec<CommitInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !has_head(&root) {
            return Ok(Vec::new());
        }
        let n = format!("-{}", limit.unwrap_or(50).min(500));
        let out = git(&root, &["log", &n, "--pretty=format:%H%x1f%an%x1f%ai%x1f%s"])?;
        Ok(out
            .lines()
            .filter_map(|line| {
                let parts: Vec<&str> = line.split('\x1f').collect();
                (parts.len() == 4).then(|| CommitInfo {
                    hash: parts[0].to_string(),
                    author: parts[1].to_string(),
                    date: parts[2].to_string(),
                    subject: parts[3].to_string(),
                })
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn is_untracked(root: &str, path: &str) -> bool {
    git(root, &["ls-files", "--others", "--exclude-standard", "--", path])
        .map(|o| !o.trim().is_empty())
        .unwrap_or(false)
}

#[tauri::command]
pub async fn git_diff(root: String, path: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(p) = path.as_deref() {
            if is_untracked(&root, p) {
                let null_path = if cfg!(windows) { "NUL" } else { "/dev/null" };
                let out = git_output(&root, &["diff", "--no-color", "--no-index", "--", null_path, p])?;
                return Ok(String::from_utf8_lossy(&out.stdout).to_string());
            }
        }
        let mut args = vec!["diff", "--no-color"];
        if has_head(&root) {
            args.push("HEAD");
        } else {
            args.push("--cached");
        }
        args.push("--");
        if let Some(p) = path.as_deref() {
            args.push(p);
        }
        git(&root, &args)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_stage(root: String, paths: Vec<String>) -> Result<(), String> {
    proc::blocking(move || stage(&root, &paths)).await
}

pub fn stage(root: &str, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = vec!["add", "-A", "--"];
    args.extend(paths.iter().map(String::as_str));
    git(root, &args).map(|_| ())
}

#[tauri::command]
pub async fn git_unstage(root: String, paths: Vec<String>) -> Result<(), String> {
    proc::blocking(move || unstage(&root, &paths)).await
}

pub fn unstage(root: &str, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = if has_head(root) {
        vec!["reset", "-q", "HEAD", "--"]
    } else {
        vec!["rm", "--cached", "-q", "--"]
    };
    args.extend(paths.iter().map(String::as_str));
    git(root, &args).map(|_| ())
}

#[tauri::command]
pub async fn git_discard(root: String, path: String) -> Result<(), String> {
    proc::blocking(move || discard(&root, &path)).await
}

pub fn discard(root: &str, path: &str) -> Result<(), String> {
    if is_untracked(root, path) {
        git(root, &["clean", "-f", "-q", "--", path])?;
    } else {
        git(root, &["checkout", "--", path])?;
    }
    Ok(())
}

#[tauri::command]
pub async fn git_commit(root: String, message: String) -> Result<String, String> {
    proc::blocking(move || commit(&root, &message)).await
}

pub fn commit(root: &str, message: &str) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("commit message is empty".into());
    }
    git(root, &["commit", "-m", message])
}

#[tauri::command]
pub async fn git_branches(root: String) -> Result<Vec<String>, String> {
    proc::blocking(move || branches(&root)).await
}

pub fn branches(root: &str) -> Result<Vec<String>, String> {
    let out = git(root, &["branch", "--format=%(refname:short)"])?;
    Ok(out.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
}

#[tauri::command]
pub async fn git_checkout(root: String, branch: String) -> Result<(), String> {
    proc::blocking(move || checkout(&root, &branch)).await
}

pub fn checkout(root: &str, branch: &str) -> Result<(), String> {
    if branch.starts_with('-') {
        return Err("invalid branch name".into());
    }
    git(root, &["checkout", branch]).map(|_| ())
}

#[tauri::command]
pub async fn git_new_branch(root: String, name: String) -> Result<(), String> {
    proc::blocking(move || new_branch(&root, &name)).await
}

pub fn new_branch(root: &str, name: &str) -> Result<(), String> {
    git(root, &["check-ref-format", "--branch", name]).map_err(|_| format!("invalid branch name: {name}"))?;
    git(root, &["checkout", "-b", name]).map(|_| ())
}

#[tauri::command]
pub async fn git_init(root: String) -> Result<(), String> {
    proc::blocking(move || init(&root)).await
}

pub fn init(root: &str) -> Result<(), String> {
    git(root, &["init"]).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ahead_and_behind() {
        let (b, u, a, h) = parse_branch_line("main...origin/main [ahead 2, behind 3]");
        assert_eq!((b.as_str(), u.as_str(), a, h), ("main", "origin/main", 2, 3));
        let (_, _, a, h) = parse_branch_line("dev...origin/dev [behind 7]");
        assert_eq!((a, h), (0, 7));
        let (b, u, a, h) = parse_branch_line("feature");
        assert_eq!((b.as_str(), u.as_str(), a, h), ("feature", "", 0, 0));
    }

    #[test]
    fn parses_fresh_and_detached_heads() {
        assert_eq!(parse_branch_line("No commits yet on main").0, "main");
        assert_eq!(parse_branch_line("HEAD (no branch)").0, "HEAD");
    }

    #[test]
    fn parses_entries_including_renames_and_quotes() {
        let out = "## main...origin/main [ahead 1]\nM  src/a.ts\n M src/b.ts\n?? new file.txt\nR  old.ts -> new.ts\n?? \"with \\\"quote\\\".txt\"\n";
        let st = parse_status(out);
        assert_eq!(st.ahead, 1);
        assert_eq!(st.entries.len(), 5);
        assert!(st.entries[0].staged);
        assert!(!st.entries[1].staged);
        assert!(!st.entries[2].staged);
        assert_eq!(st.entries[2].path, "new file.txt");
        assert_eq!(st.entries[3].path, "new.ts");
        assert_eq!(st.entries[4].path, "with \"quote\".txt");
    }

    #[test]
    fn works_against_a_real_repository() {
        if proc::find_executable("git").is_none() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("fcc-git-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().to_string();
        init(&root).unwrap();
        git(&root, &["config", "user.email", "t@example.com"]).unwrap();
        git(&root, &["config", "user.name", "t"]).unwrap();
        std::fs::write(dir.join("a.txt"), "hello\n").unwrap();
        let st = tauri::async_runtime::block_on(git_status(root.clone())).unwrap();
        assert!(st.repo);
        assert_eq!(st.entries.len(), 1);
        let diff = tauri::async_runtime::block_on(git_diff(root.clone(), Some("a.txt".into()))).unwrap();
        assert!(diff.contains("+hello"));
        stage(&root, &["a.txt".to_string()]).unwrap();
        unstage(&root, &["a.txt".to_string()]).unwrap();
        stage(&root, &["a.txt".to_string()]).unwrap();
        commit(&root, "init").unwrap();
        let log = tauri::async_runtime::block_on(git_log(root.clone(), Some(5))).unwrap();
        assert_eq!(log.len(), 1);
        std::fs::write(dir.join("b.txt"), "x").unwrap();
        discard(&root, "b.txt").unwrap();
        assert!(!dir.join("b.txt").exists());
        assert!(new_branch(&root, "bad..name").is_err());
        new_branch(&root, "feature/x").unwrap();
        assert!(branches(&root).unwrap().contains(&"feature/x".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
