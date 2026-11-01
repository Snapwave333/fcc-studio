use serde::Serialize;

use crate::platform;

fn git(dir: &str, args: &[&str]) -> Result<String, String> {
    let output = platform::command("git")
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .args(["-c", "core.quotepath=false"])
        .args(args)
        .output()
        .map_err(|e| format!("git not available: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(if stderr.is_empty() { stdout } else { stderr });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct StatusEntry {
    pub path: String,
    pub x: String,
    pub y: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitStatus {
    pub repo: bool,
    pub branch: String,
    pub upstream: String,
    pub ahead: i32,
    pub behind: i32,
    pub entries: Vec<StatusEntry>,
}

fn unquote(path: &str) -> String {
    let p = path.trim();
    if p.len() >= 2 && p.starts_with('"') && p.ends_with('"') {
        p[1..p.len() - 1].replace("\\\"", "\"").replace("\\\\", "\\")
    } else {
        p.to_string()
    }
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
            let (head, tracking) = match rest.find(" [") {
                Some(i) => (&rest[..i], Some(&rest[i + 2..])),
                None => (rest, None),
            };
            let mut segs = head.splitn(2, "...");
            let b = segs.next().unwrap_or("").trim();
            status.branch = if let Some(name) = b.strip_prefix("No commits yet on ") {
                name.to_string()
            } else if let Some(name) = b.strip_prefix("Initial commit on ") {
                name.to_string()
            } else if b.starts_with("HEAD (no branch)") || b.is_empty() {
                "HEAD".into()
            } else {
                b.to_string()
            };
            status.upstream = segs.next().unwrap_or("").trim().to_string();
            if let Some(t) = tracking {
                for part in t.trim_end_matches(']').split(',') {
                    let part = part.trim();
                    if let Some(n) = part.strip_prefix("ahead ") {
                        status.ahead = n.trim().parse().unwrap_or(0);
                    } else if let Some(n) = part.strip_prefix("behind ") {
                        status.behind = n.trim().parse().unwrap_or(0);
                    }
                }
            }
        } else if line.len() >= 4 {
            let x = line[0..1].to_string();
            let y = line[1..2].to_string();
            let raw = &line[3..];
            let path = match raw.find(" -> ") {
                Some(i) => unquote(&raw[i + 4..]),
                None => unquote(raw),
            };
            let untracked = x == "?";
            status.entries.push(StatusEntry {
                path,
                staged: x != " " && !untracked && x != "!",
                unstaged: y != " " || untracked,
                untracked,
                x,
                y,
            });
        }
    }
    status
}

#[tauri::command]
pub async fn git_status(root: String) -> Result<GitStatus, String> {
    tauri::async_runtime::spawn_blocking(move || match git(&root, &["status", "--porcelain=v1", "-b", "-uall"]) {
        Ok(out) => parse_status(&out),
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
        let n = format!("-{}", limit.unwrap_or(50).clamp(1, 1000));
        let out = match git(&root, &["log", &n, "--pretty=format:%H%x1f%an%x1f%aI%x1f%s"]) {
            Ok(o) => o,
            Err(e) if e.contains("does not have any commits") || e.contains("bad default revision") => String::new(),
            Err(e) => return Err(e),
        };
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

fn has_head(root: &str) -> bool {
    git(root, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok()
}

#[tauri::command]
pub async fn git_diff(root: String, path: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(p) = &path {
            let tracked = git(&root, &["ls-files", "--error-unmatch", "--", p]).is_ok();
            if !tracked {
                let full = std::path::Path::new(&root).join(p);
                let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
                let full_s = full.to_string_lossy().to_string();
                let output = platform::command("git")
                    .current_dir(&root)
                    .args(["-c", "core.quotepath=false", "diff", "--no-index", "--", null, &full_s])
                    .output()
                    .map_err(|e| e.to_string())?;
                return Ok(String::from_utf8_lossy(&output.stdout).to_string());
            }
        }
        let mut args: Vec<&str> = vec!["diff"];
        if has_head(&root) {
            args.push("HEAD");
        } else {
            args.push("--cached");
        }
        args.push("--");
        if let Some(p) = &path {
            args.push(p);
        }
        git(&root, &args)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn git_stage(root: String, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        git(&root, &["add", "-A"])?;
        return Ok(());
    }
    let mut args = vec!["add", "-A", "--"];
    args.extend(paths.iter().map(|s| s.as_str()));
    git(&root, &args)?;
    Ok(())
}

#[tauri::command]
pub fn git_unstage(root: String, paths: Vec<String>) -> Result<(), String> {
    let mut args: Vec<&str> = if has_head(&root) {
        vec!["reset", "-q", "HEAD", "--"]
    } else {
        vec!["rm", "--cached", "-r", "-q", "--"]
    };
    args.extend(paths.iter().map(|s| s.as_str()));
    git(&root, &args)?;
    Ok(())
}

#[tauri::command]
pub fn git_discard(root: String, path: String) -> Result<(), String> {
    let tracked = git(&root, &["ls-files", "--error-unmatch", "--", &path]).is_ok();
    if tracked {
        if has_head(&root) {
            git(&root, &["checkout", "HEAD", "--", &path])?;
        } else {
            git(&root, &["checkout", "--", &path])?;
        }
    } else {
        git(&root, &["clean", "-f", "-q", "--", &path])?;
    }
    Ok(())
}

#[tauri::command]
pub fn git_commit(root: String, message: String) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("commit message is empty".into());
    }
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

fn valid_branch_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('-')
        && !name.contains("..")
        && !name.ends_with('/')
        && !name.ends_with(".lock")
        && !name.chars().any(|c| c.is_whitespace() || c.is_control() || "~^:?*[\\".contains(c))
}

#[tauri::command]
pub fn git_new_branch(root: String, name: String) -> Result<(), String> {
    let name = name.trim();
    if !valid_branch_name(name) {
        return Err(format!("'{name}' is not a valid branch name"));
    }
    git(&root, &["checkout", "-b", name])?;
    Ok(())
}

#[tauri::command]
pub fn git_init(root: String) -> Result<(), String> {
    git(&root, &["init"])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_tracking_and_entries() {
        let out = "## main...origin/main [ahead 2, behind 1]\nM  src/a.ts\n M src/b.ts\nR  old.ts -> new.ts\n?? \"with space.txt\"\n";
        let st = parse_status(out);
        assert_eq!(st.branch, "main");
        assert_eq!(st.upstream, "origin/main");
        assert_eq!(st.ahead, 2);
        assert_eq!(st.behind, 1);
        assert_eq!(st.entries.len(), 4);
        assert!(st.entries[0].staged && !st.entries[0].unstaged);
        assert!(!st.entries[1].staged && st.entries[1].unstaged);
        assert_eq!(st.entries[2].path, "new.ts");
        assert_eq!(st.entries[3].path, "with space.txt");
        assert!(st.entries[3].untracked);
    }

    #[test]
    fn parses_fresh_repository_header() {
        let st = parse_status("## No commits yet on main\n");
        assert_eq!(st.branch, "main");
        assert_eq!(st.ahead, 0);
    }

    #[test]
    fn partially_staged_file_appears_in_both_lists() {
        let st = parse_status("## dev\nMM src/x.rs\n");
        assert!(st.entries[0].staged && st.entries[0].unstaged);
    }

    #[test]
    fn branch_names_are_validated() {
        assert!(valid_branch_name("feature/login"));
        assert!(!valid_branch_name("-rf"));
        assert!(!valid_branch_name("a..b"));
        assert!(!valid_branch_name("has space"));
    }

    #[test]
    fn real_repository_round_trip() {
        if platform::which("git").is_none() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("serenity-git-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().to_string();
        git_init(root.clone()).unwrap();
        git(&root, &["config", "user.email", "t@example.com"]).unwrap();
        git(&root, &["config", "user.name", "t"]).unwrap();
        std::fs::write(dir.join("a.txt"), "hello\n").unwrap();
        let st = parse_status(&git(&root, &["status", "--porcelain=v1", "-b", "-uall"]).unwrap());
        assert!(st.entries.iter().any(|e| e.path == "a.txt" && e.untracked));
        git_stage(root.clone(), vec!["a.txt".into()]).unwrap();
        git_unstage(root.clone(), vec!["a.txt".into()]).unwrap();
        git_stage(root.clone(), vec![]).unwrap();
        git_commit(root.clone(), "init".into()).unwrap();
        std::fs::write(dir.join("a.txt"), "changed\n").unwrap();
        let diff = git(&root, &["diff", "HEAD", "--", "a.txt"]).unwrap();
        assert!(diff.contains("+changed"));
        git_discard(root.clone(), "a.txt".into()).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "hello\n");
        std::fs::write(dir.join("junk.txt"), "x").unwrap();
        git_discard(root.clone(), "junk.txt".into()).unwrap();
        assert!(!dir.join("junk.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
