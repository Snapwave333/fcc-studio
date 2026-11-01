mod agent;
mod db;
mod elevation;
mod fs_cmds;
mod git;
mod platform;
mod preview;
mod pty;
mod redline;
mod relay;
mod skills;

use agent::AgentState;
use db::Db;
use fs_cmds::FsWatchState;
use preview::PreviewState;
use pty::PtyState;
use redline::RedlineState;
use tauri::Manager;

fn shutdown(app: &tauri::AppHandle) {
    if let Some(agents) = app.try_state::<AgentState>() {
        agents.kill_all();
    }
    if let Some(ptys) = app.try_state::<PtyState>() {
        ptys.kill_all();
    }
    if let Some(preview) = app.try_state::<PreviewState>() {
        preview.stop();
    }
    if let Some(watch) = app.try_state::<FsWatchState>() {
        if let Ok(mut w) = watch.watcher.lock() {
            *w = None;
        }
    }
}

#[tauri::command]
fn app_info(app: tauri::AppHandle) -> serde_json::Value {
    serde_json::json!({
        "version": app.package_info().version.to_string(),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "default_shell": platform::default_shell(),
        "data_dir": app.path().app_data_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
    })
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let database = Db::open(data_dir.join("fcc-studio.db"))?;
            app.manage(RedlineState::restore(&database));
            app.manage(database);
            app.manage(AgentState::default());
            app.manage(PtyState::default());
            app.manage(PreviewState::default());
            app.manage(FsWatchState::default());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    shutdown(window.app_handle());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            db::list_projects,
            db::create_project,
            db::update_project,
            db::delete_project,
            db::add_message,
            db::list_messages,
            db::memory_list,
            db::memory_save,
            db::memory_delete,
            db::kv_get,
            db::kv_set,
            db::clear_messages,
            fs_cmds::list_dir,
            fs_cmds::read_file,
            fs_cmds::write_file,
            fs_cmds::create_dir,
            fs_cmds::rename_path,
            fs_cmds::delete_path,
            fs_cmds::search_project,
            fs_cmds::open_in_explorer,
            fs_cmds::pick_folder,
            fs_cmds::start_fs_watch,
            agent::detect_environment,
            agent::start_agent_run,
            agent::cancel_agent_run,
            pty::pty_create,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_kill_all,
            relay::relay_status,
            relay::open_external,
            preview::preview_start,
            preview::preview_stop,
            preview::preview_state,
            preview::dev_server_scan,
            git::git_status,
            git::git_log,
            git::git_diff,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_commit,
            git::git_branches,
            git::git_checkout,
            git::git_new_branch,
            git::git_init,
            redline::redline_status,
            redline::redline_activate,
            redline::redline_deactivate,
            redline::redline_benchmark_start,
            redline::redline_bench_running,
            redline::redline_leaderboard,
            redline::redline_install_ollama,
            skills::skills_list,
            skills::skills_read,
            skills::skills_write,
            skills::skills_create,
            skills::skills_delete,
            elevation::elevation_status,
            elevation::request_elevation,
            elevation::audit_write,
            elevation::audit_read,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Serenity")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                shutdown(app);
            }
        });
}
