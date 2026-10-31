use serde::Serialize;
use std::path::{Path, PathBuf};

fn global_skills_dir() -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE").ok()?;
    Some(PathBuf::from(home).join(".claude").join("skills"))
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
            name = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("description:") {
            description = v.trim().to_string();
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
    let mut project: Vec<SkillInfo> = project_root
        .as_ref()
        .map(|r| scan_skills(&project_skills_dir(r), "project"))
        .unwrap_or_default();
    global.extend(project.drain(..));
    let names: Vec<String> = global.iter().map(|s| s.name.clone()).collect();
    Ok(serde_json::json!({ "skills": global, "names": names }))
}

#[tauri::command]
pub fn skills_read(path: String) -> Result<String, String> {
    if !path.ends_with("SKILL.md") {
        return Err("only SKILL.md files can be opened here".into());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

fn ensure_allowed(path: &Path) -> Result<(), String> {
    let in_global = global_skills_dir()
        .map(|g| path.starts_with(&g))
        .unwrap_or(false);
    let textual = path.to_string_lossy().replace('/', "\\");
    let in_project = textual.contains("\\.claude\\skills\\");
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
    let tmp = p.with_extension("md.fcc-tmp");
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, p).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn skills_create(scope: String, project_root: Option<String>, name: String) -> Result<String, String> {
    let safe: String = name
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
    let template = format!(
        "---\nname: {safe}\ndescription: Describe what this skill does and when to use it\n---\n\n# {safe}\n\nInstructions for the agent go here.\n"
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
