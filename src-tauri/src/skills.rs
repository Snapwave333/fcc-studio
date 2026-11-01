use serde::Serialize;
use std::path::{Path, PathBuf};

fn global_skills_dir() -> Option<PathBuf> {
    Some(crate::platform::home_dir()?.join(".claude").join("skills"))
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
            name = v.trim().trim_matches(['"', '\'']).to_string();
        } else if let Some(v) = line.strip_prefix("description:") {
            description = v.trim().trim_matches(['"', '\'']).to_string();
        }
    }
    (name, description)
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
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

#[tauri::command]
pub fn skills_list(project_root: Option<String>) -> Result<serde_json::Value, String> {
    let mut global = global_skills_dir()
        .map(|d| scan_skills(&d, "global"))
        .unwrap_or_default();
    let project: Vec<SkillInfo> = project_root
        .as_ref()
        .map(|r| scan_skills(&project_skills_dir(r), "project"))
        .unwrap_or_default();
    global.extend(project);
    let names: Vec<String> = global.iter().map(|s| s.name.clone()).collect();
    Ok(serde_json::json!({ "skills": global, "names": names }))
}

#[tauri::command]
pub fn skills_read(path: String) -> Result<String, String> {
    if !path.ends_with("SKILL.md") {
        return Err("only SKILL.md files can be opened here".into());
    }
    ensure_allowed(Path::new(&path))?;
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

pub fn ensure_allowed(path: &Path) -> Result<(), String> {
    use std::path::Component;
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("path is outside the skills directories".into());
    }
    let in_global = global_skills_dir()
        .map(|g| path.starts_with(&g))
        .unwrap_or(false);
    let names: Vec<String> = path
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect();
    let in_project = names
        .windows(4)
        .any(|w| w[0] == ".claude" && w[1] == "skills" && !w[2].is_empty() && w[3] == "SKILL.md")
        && names.last().map(|n| n == "SKILL.md").unwrap_or(false);
    if !(in_global || in_project) {
        return Err("path is outside the skills directories".into());
    }
    Ok(())
}

#[tauri::command]
pub fn skills_write(path: String, content: String) -> Result<(), String> {
    let p = Path::new(&path);
    ensure_allowed(p)?;
    if !p.ends_with("SKILL.md") {
        return Err("only SKILL.md files can be saved here".into());
    }
    crate::fs_cmds::write_file(path.clone(), content)
}

#[tauri::command]
pub fn skills_create(scope: String, project_root: Option<String>, name: String) -> Result<String, String> {
    let safe: String = name
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
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
    let template = format!(
        "---\nname: {safe}\ndescription: Use when the task involves {title}.\n---\n\n# {title}\n\n## When to use\n\n- The user asks for work related to {title}.\n\n## Steps\n\n1. Inspect the relevant files before changing anything.\n2. Make the smallest change that satisfies the request.\n3. Run the project's build and tests and report the results.\n", title = safe.replace(['-', '_'], " ")
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
    fn frontmatter_is_parsed() {
        let (n, d) = parse_frontmatter("---\nname: \"deploy\"\ndescription: Ship it\n---\nbody");
        assert_eq!(n, "deploy");
        assert_eq!(d, "Ship it");
    }

    #[test]
    fn only_skill_files_are_writable() {
        assert!(ensure_allowed(Path::new("/work/app/.claude/skills/deploy/SKILL.md")).is_ok());
        assert!(ensure_allowed(Path::new("/work/app/.claude/skills/../../secrets/SKILL.md")).is_err());
        assert!(ensure_allowed(Path::new("/etc/passwd")).is_err());
        assert!(ensure_allowed(Path::new("/work/.claude/skills/x/other.md")).is_err());
    }

    #[test]
    fn create_list_delete_project_skill() {
        let root = std::env::temp_dir().join(format!("serenity-skills-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let r = root.to_string_lossy().to_string();
        let path = skills_create("project".into(), Some(r.clone()), "My Skill!".into()).unwrap();
        assert!(path.ends_with("SKILL.md"));
        let listed = scan_skills(&project_skills_dir(&r), "project");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "my-skill");
        assert!(skills_create("project".into(), Some(r.clone()), "my-skill".into()).is_err());
        skills_delete(path).unwrap();
        assert!(scan_skills(&project_skills_dir(&r), "project").is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }
}
