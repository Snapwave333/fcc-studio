use serde::Serialize;
use std::path::{Component, Path, PathBuf};

use crate::proc;

fn global_skills_dir() -> Option<PathBuf> {
    Some(proc::home_dir()?.join(".claude").join("skills"))
}

fn project_skills_dir(root: &str) -> PathBuf {
    PathBuf::from(root).join(".claude").join("skills")
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillInfo {
    pub name: String,
    pub scope: String,
    pub path: String,
    pub description: String,
    pub modified: f64,
}

fn parse_frontmatter(content: &str) -> (String, String) {
    let mut name = String::new();
    let mut description = String::new();
    let mut in_front = false;
    let mut dashes = 0;
    for line in content.lines() {
        if line.trim() == "---" {
            dashes += 1;
            if dashes >= 2 {
                break;
            }
            in_front = dashes == 1;
            continue;
        }
        if !in_front {
            continue;
        }
        if let Some(v) = line.strip_prefix("name:") {
            name = strip_yaml_quotes(v);
        } else if let Some(v) = line.strip_prefix("description:") {
            description = strip_yaml_quotes(v);
        }
    }
    (name, description)
}

fn strip_yaml_quotes(v: &str) -> String {
    let t = v.trim();
    if t.len() >= 2 && ((t.starts_with('"') && t.ends_with('"')) || (t.starts_with('\'') && t.ends_with('\''))) {
        t[1..t.len() - 1].to_string()
    } else {
        t.to_string()
    }
}

fn scan_skills(dir: &Path, scope: &str) -> Vec<SkillInfo> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let skill_md = entry.path().join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&skill_md) else {
            continue;
        };
        let (name, description) = parse_frontmatter(&content);
        let dir_name = entry.file_name().to_string_lossy().to_string();
        let modified = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        out.push(SkillInfo {
            name: if name.is_empty() { dir_name } else { name },
            scope: scope.to_string(),
            path: skill_md.to_string_lossy().to_string(),
            description,
            modified,
        });
    }
    out.sort_by_key(|s| s.name.to_lowercase());
    out
}

#[tauri::command]
pub fn skills_list(project_root: Option<String>) -> Result<serde_json::Value, String> {
    let mut global = global_skills_dir()
        .map(|d| scan_skills(&d, "global"))
        .unwrap_or_default();
    let mut project: Vec<SkillInfo> = project_root
        .as_ref()
        .map(|r| scan_skills(&project_skills_dir(r), "project"))
        .unwrap_or_default();
    global.append(&mut project);
    let names: Vec<String> = global.iter().map(|s| s.name.clone()).collect();
    Ok(serde_json::json!({ "skills": global, "names": names }))
}

pub fn is_inside_skills_dir(path: &Path) -> bool {
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return false;
    }
    if global_skills_dir().map(|g| path.starts_with(&g)).unwrap_or(false) {
        return true;
    }
    let names: Vec<String> = path
        .components()
        .filter_map(|c| match c {
            Component::Normal(n) => Some(n.to_string_lossy().to_string()),
            _ => None,
        })
        .collect();
    names.windows(2).any(|w| w[0] == ".claude" && w[1] == "skills")
}

fn ensure_allowed(path: &Path) -> Result<(), String> {
    if !is_inside_skills_dir(path) {
        return Err("path is outside the skills directories".into());
    }
    Ok(())
}

#[tauri::command]
pub fn skills_read(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    ensure_allowed(p)?;
    if !p.ends_with("SKILL.md") {
        return Err("only SKILL.md files can be opened here".into());
    }
    std::fs::read_to_string(p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn skills_write(path: String, content: String) -> Result<(), String> {
    let p = Path::new(&path);
    ensure_allowed(p)?;
    if !p.ends_with("SKILL.md") {
        return Err("only SKILL.md files can be saved here".into());
    }
    let tmp = p.with_extension("md.fcc-tmp");
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, p).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn skills_create(scope: String, project_root: Option<String>, name: String) -> Result<String, String> {
    let safe: String = name
        .trim()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    if safe.is_empty() {
        return Err("invalid skill name".into());
    }
    let dir = match scope.as_str() {
        "global" => global_skills_dir().ok_or("cannot resolve home directory")?,
        "project" => {
            let root = project_root.ok_or("no project selected")?;
            project_skills_dir(&root)
        }
        _ => return Err("unknown scope".into()),
    };
    let skill_dir = dir.join(&safe);
    let skill_md = skill_dir.join("SKILL.md");
    if skill_md.exists() {
        return Err(format!("skill '{safe}' already exists"));
    }
    std::fs::create_dir_all(&skill_dir).map_err(|e| e.to_string())?;
    let title = safe.replace(['-', '_'], " ");
    let template = format!(
        "---\nname: {safe}\ndescription: Use when the task involves {title}\n---\n\n# {title}\n\n## When to use\n\n- The user asks for work related to {title}\n\n## Steps\n\n1. Inspect the relevant files in the project before changing anything\n2. Make the smallest change that fully solves the request\n3. Run the project's build and tests and fix any failures\n4. Summarize what changed and how it was verified\n"
    );
    std::fs::write(&skill_md, template).map_err(|e| e.to_string())?;
    Ok(skill_md.to_string_lossy().to_string())
}

#[tauri::command]
pub fn skills_delete(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    ensure_allowed(p)?;
    let dir = p.parent().ok_or("invalid skill path")?;
    if !dir.join("SKILL.md").exists() {
        return Err("not a skill directory".into());
    }
    std::fs::remove_dir_all(dir).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frontmatter_with_quotes() {
        let (n, d) = parse_frontmatter("---\nname: \"deploy\"\ndescription: 'Ship it'\n---\n# body\nname: ignored\n");
        assert_eq!(n, "deploy");
        assert_eq!(d, "Ship it");
    }

    #[test]
    fn restricts_paths_to_skill_dirs() {
        assert!(is_inside_skills_dir(Path::new("/work/app/.claude/skills/x/SKILL.md")));
        assert!(!is_inside_skills_dir(Path::new("/work/app/.claude/skills/../../etc/SKILL.md")));
        assert!(!is_inside_skills_dir(Path::new("/etc/SKILL.md")));
    }

    #[test]
    fn creates_lists_and_deletes_project_skill() {
        let root = std::env::temp_dir().join(format!("fcc-skill-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let r = root.to_string_lossy().to_string();
        let path = skills_create("project".into(), Some(r.clone()), "My Skill!".into()).unwrap();
        assert!(skills_create("project".into(), Some(r.clone()), "My Skill!".into()).is_err());
        let listed = skills_list(Some(r.clone())).unwrap();
        assert!(listed["names"].as_array().unwrap().iter().any(|n| n == "My-Skill-"));
        let body = skills_read(path.clone()).unwrap();
        assert!(body.contains("description: Use when"));
        skills_write(path.clone(), "---\nname: renamed\n---\n".into()).unwrap();
        assert!(skills_read(path.clone()).unwrap().contains("renamed"));
        skills_delete(path).unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }
}
