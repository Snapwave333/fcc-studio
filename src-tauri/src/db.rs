use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct Db(pub Arc<Mutex<Connection>>);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub root: String,
    pub instructions: String,
    pub preview_url: String,
    pub layout: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredMessage {
    pub id: String,
    pub project_id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub meta: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryEntry {
    pub id: String,
    pub scope: String,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
}

impl Db {
    pub fn open(path: PathBuf) -> Result<Self, String> {
        let conn = Connection::open(&path).map_err(|e| e.to_string())?;
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA busy_timeout = 5000;
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS projects(
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                root TEXT NOT NULL UNIQUE,
                instructions TEXT NOT NULL DEFAULT '',
                preview_url TEXT NOT NULL DEFAULT '',
                layout TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages(
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                session_id TEXT NOT NULL DEFAULT '',
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                meta TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id, created_at);
            CREATE TABLE IF NOT EXISTS memory(
                id TEXT PRIMARY KEY,
                scope TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'note',
                title TEXT NOT NULL,
                body TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory(scope);
            CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS benchmarks(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                model TEXT NOT NULL,
                task TEXT NOT NULL,
                score REAL NOT NULL,
                latency_ms INTEGER NOT NULL DEFAULT 0,
                tokens INTEGER NOT NULL DEFAULT 0,
                detail TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_bench_model ON benchmarks(model);
            "#,
        )
        .map_err(|e| e.to_string())?;
        Ok(Db(Arc::new(Mutex::new(conn))))
    }

    fn now() -> String {
        chrono::Utc::now().to_rfc3339()
    }
}

fn row_to_project(row: &rusqlite::Row) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        root: row.get(2)?,
        instructions: row.get(3)?,
        preview_url: row.get(4)?,
        layout: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

#[tauri::command]
pub fn list_projects(db: tauri::State<Db>) -> Result<Vec<Project>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, root, instructions, preview_url, layout, created_at, updated_at FROM projects ORDER BY updated_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_project)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
pub fn create_project(
    db: tauri::State<Db>,
    name: String,
    root: String,
    instructions: String,
) -> Result<Project, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        std::fs::create_dir_all(&root_path).map_err(|e| format!("could not create project dir: {e}"))?;
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = Db::now();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO projects(id, name, root, instructions, preview_url, layout, created_at, updated_at) VALUES(?1,?2,?3,?4,'','',?5,?5)",
        params![id, name, root, instructions, now],
    )
    .map_err(|e| {
        if e.to_string().contains("UNIQUE") {
            format!("a project already uses the folder {root}")
        } else {
            e.to_string()
        }
    })?;
    Ok(Project {
        id,
        name,
        root,
        instructions,
        preview_url: String::new(),
        layout: String::new(),
        created_at: now.clone(),
        updated_at: now,
    })
}

#[tauri::command]
pub fn update_project(
    db: tauri::State<Db>,
    id: String,
    name: Option<String>,
    instructions: Option<String>,
    preview_url: Option<String>,
    layout: Option<String>,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    if let Some(n) = name {
        conn.execute("UPDATE projects SET name=?2 WHERE id=?1", params![id, n])
            .map_err(|e| e.to_string())?;
    }
    if let Some(i) = instructions {
        conn.execute("UPDATE projects SET instructions=?2 WHERE id=?1", params![id, i])
            .map_err(|e| e.to_string())?;
    }
    if let Some(p) = preview_url {
        conn.execute("UPDATE projects SET preview_url=?2 WHERE id=?1", params![id, p])
            .map_err(|e| e.to_string())?;
    }
    if let Some(l) = layout {
        conn.execute("UPDATE projects SET layout=?2 WHERE id=?1", params![id, l])
            .map_err(|e| e.to_string())?;
    }
    conn.execute(
        "UPDATE projects SET updated_at=?2 WHERE id=?1",
        params![id, Db::now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_project(db: tauri::State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM projects WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM messages WHERE project_id=?1", params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM memory WHERE scope=?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn clear_messages(db: tauri::State<Db>, project_id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM messages WHERE project_id=?1", params![project_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn add_message(
    db: tauri::State<Db>,
    project_id: String,
    session_id: String,
    role: String,
    content: String,
    meta: String,
) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO messages(id, project_id, session_id, role, content, meta, created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![id, project_id, session_id, role, content, meta, Db::now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn list_messages(db: tauri::State<Db>, project_id: String) -> Result<Vec<StoredMessage>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, project_id, session_id, role, content, meta, created_at FROM (SELECT rowid AS rid, * FROM messages WHERE project_id=?1 ORDER BY created_at DESC, rid DESC LIMIT 500) ORDER BY created_at ASC, rid ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![project_id], |row| {
            Ok(StoredMessage {
                id: row.get(0)?,
                project_id: row.get(1)?,
                session_id: row.get(2)?,
                role: row.get(3)?,
                content: row.get(4)?,
                meta: row.get(5)?,
                created_at: row.get(6)?,
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
pub fn memory_list(db: tauri::State<Db>, scope: String) -> Result<Vec<MemoryEntry>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, scope, kind, title, body, created_at, updated_at FROM memory WHERE scope=?1 ORDER BY updated_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![scope], |row| {
            Ok(MemoryEntry {
                id: row.get(0)?,
                scope: row.get(1)?,
                kind: row.get(2)?,
                title: row.get(3)?,
                body: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
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
pub fn memory_save(
    db: tauri::State<Db>,
    id: Option<String>,
    scope: String,
    kind: String,
    title: String,
    body: String,
) -> Result<MemoryEntry, String> {
    let now = Db::now();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let id = match id {
        Some(existing) => {
            conn.execute(
                "UPDATE memory SET kind=?2, title=?3, body=?4, updated_at=?5 WHERE id=?1",
                params![existing, kind, title, body, now],
            )
            .map_err(|e| e.to_string())?;
            existing
        }
        None => {
            let new_id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO memory(id, scope, kind, title, body, created_at, updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![new_id, scope, kind, title, body, now, now],
            )
            .map_err(|e| e.to_string())?;
            new_id
        }
    };
    let created: Option<String> = conn
        .query_row("SELECT created_at FROM memory WHERE id=?1", params![id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(MemoryEntry {
        id,
        scope,
        kind,
        title,
        body,
        created_at: created.unwrap_or_else(|| now.clone()),
        updated_at: now,
    })
}

#[tauri::command]
pub fn memory_delete(db: tauri::State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM memory WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn kv_get(db: tauri::State<Db>, key: String) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let val: Option<String> = conn
        .query_row("SELECT value FROM kv WHERE key=?1", params![key], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(val)
}

#[tauri::command]
pub fn kv_set(db: tauri::State<Db>, key: String, value: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO kv(key, value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_initialises_and_is_idempotent() {
        let path = std::env::temp_dir().join(format!("serenity-db-{}.db", uuid::Uuid::new_v4()));
        let db = Db::open(path.clone()).unwrap();
        drop(db);
        let db = Db::open(path.clone()).unwrap();
        let conn = db.0.lock().unwrap();
        let tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('projects','messages','memory','kv','benchmarks')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 5);
        drop(conn);
        drop(db);
        let _ = std::fs::remove_file(&path);
    }
}
