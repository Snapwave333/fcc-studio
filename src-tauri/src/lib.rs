mod agent;
mod db;
mod elevation;
mod fs_cmds;
mod git;
mod preview;
mod pty;
mod redline;
mod relay;
mod skills;

use agent::AgentState;
use db::Db;
use pty::PtyState;
use redline::RedlineState;
use preview::PreviewState;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let database = Db::open(data_dir.join("fcc-studio.db"))?;
            app.manage(database);
            app.manage(AgentState::default());
            app.manage(PtyState::default());
            app.manage(PreviewState::default());
            app.manage(RedlineState::default());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let _ = window;
            }
        })
        .invoke_handler(tauri::generate_handler![
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
        .run(tauri::generate_context!())
        .expect("error while running FCC Studio");
}
