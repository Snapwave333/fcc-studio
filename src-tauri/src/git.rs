use serde::Serialize;
use std::os::windows::process::CommandExt;
use std::process::Command;

fn git(dir: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .current_dir(dir)
        .args(args)
        .creation_flags(0x0800_0000)
        .output()
        .map_err(|e| format!("git not available: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        return Err(stderr.trim().to_string());
    }
    Ok(stdout)
}

#[derive(Debug, Clone, Serialize)]
pub struct StatusEntry {
    pub path: String,
    pub x: String,
    pub y: String,
    pub staged: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitStatus {
    pub repo: bool,
    pub branch: String,
    pub ahead: i32,
    pub behind: i32,
    pub entries: Vec<StatusEntry>,
}

#[tauri::command]
pub fn git_status(root: String) -> Result<GitStatus, String> {
    let out = match git(&root, &["status", "--porcelain=v1", "-b"]) {
        Ok(o) => o,
        Err(_) => {
            return Ok(GitStatus {
                repo: false,
                branch: String::new(),
                ahead: 0,
                behind: 0,
                entries: Vec::new(),
            })
        }
    };
    let mut branch = String::new();
    let mut ahead = 0;
    let mut behind = 0;
    let mut entries = Vec::new();
    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            let mut segs = rest.split("...");
            if let Some(b) = segs.next() {
                branch = b.trim_start_matches("HEAD (no branch)").to_string();
                if branch.is_empty() {
                    branch = "HEAD".into();
                }
            }
            if let Some(ab) = segs.next() {
                for part in ab.split_whitespace() {
                    if let Some(n) = part.strip_prefix('[') {
                        continue;
                    }
                    if let Some(numstr) = part.strip_prefix('+') {
                        ahead = numstr.parse().unwrap_or(0);
                    } else if let Some(numstr) = part.strip_prefix('-') {
                        behind = numstr.parse().unwrap_or(0);
                    }
                }
            }
        } else if line.len() >= 3 {
            let x = line[0..1].to_string();
            let y = line[1..2].to_string();
            let path = line[3..].trim().to_string();
            entries.push(StatusEntry {
                path,
                staged: x != " " && x != "?",
                x,
                y,
            });
        }
    }
    Ok(GitStatus {
        repo: true,
        branch,
        ahead,
        behind,
        entries,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct CommitInfo {
    pub hash: String,
    pub author: String,
    pub date: String,
    pub subject: String,
}

#[tauri::command]
pub fn git_log(root: String, limit: Option<u32>) -> Result<Vec<CommitInfo>, String> {
    let n = limit.unwrap_or(50).to_string();
    let fmt = "%H%x1f%an%x1f%ai%x1f%s";
    let out = git(
        &root,
        &["log", &format!("-{}", n), &format!("--pretty=format:{}", fmt)],
    )?;
    let mut commits = Vec::new();
    for line in out.lines() {
        let parts: Vec<&str> = line.split('\x1f').collect();
        if parts.len() == 4 {
            commits.push(CommitInfo {
                hash: parts[0].to_string(),
                author: parts[1].to_string(),
                date: parts[2].to_string(),
                subject: parts[3].to_string(),
            });
        }
    }
    Ok(commits)
}

#[tauri::command]
pub fn git_diff(root: String, path: Option<String>) -> Result<String, String> {
    let mut args = vec!["diff", "HEAD", "--"];
    if let Some(p) = &path {
        args.push(p);
    }
    git(&root, &args)
}

#[tauri::command]
pub fn git_stage(root: String, paths: Vec<String>) -> Result<(), String> {
    let mut args = vec!["add".to_string(), "--".to_string()];
    args.extend(paths);
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    git(&root, &refs)?;
    Ok(())
}

#[tauri::command]
pub fn git_unstage(root: String, paths: Vec<String>) -> Result<(), String> {
    let mut args = vec!["reset".to_string(), "HEAD".to_string(), "--".to_string()];
    args.extend(paths);
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    git(&root, &refs)?;
    Ok(())
}

#[tauri::command]
pub fn git_discard(root: String, path: String) -> Result<(), String> {
    git(&root, &["checkout", "--", &path])?;
    Ok(())
}

#[tauri::command]
pub fn git_commit(root: String, message: String) -> Result<String, String> {
    git(&root, &["commit", "-m", &message])
}

#[tauri::command]
pub fn git_branches(root: String) -> Result<Vec<String>, String> {
    let out = git(&root, &["branch", "--format=%(refname:short)"])?;
    Ok(out.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
}

#[tauri::command]
pub fn git_checkout(root: String, branch: String) -> Result<(), String> {
    git(&root, &["checkout", &branch])?;
    Ok(())
}

#[tauri::command]
pub fn git_new_branch(root: String, name: String) -> Result<(), String> {
    git(&root, &["checkout", "-b", &name])?;
    Ok(())
}

#[tauri::command]
pub fn git_init(root: String) -> Result<(), String> {
    git(&root, &["init"])?;
    Ok(())
}
