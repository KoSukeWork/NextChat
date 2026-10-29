// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod mcp;
mod stream;
mod sync_http;
mod zoom;
mod tts;
use std::sync::Arc;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let directory = app
                .path_resolver()
                .app_config_dir()
                .ok_or("Missing application config directory")?;
            std::fs::create_dir_all(&directory)?;
            // Generic filesystem IPC (including save-dialog grants) must not bypass MCP approval.
            app.fs_scope().forbid_directory(&directory, true)?;
            app.manage(Arc::new(mcp::McpState::new(
                directory.join("mcp_config.json"),
            )));
            app.manage(tts::setup(app)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            stream::stream_fetch,
            sync_http::sync_http,
            mcp::mcp_read_config,
            mcp::mcp_write_config,
            mcp::mcp_spawn,
            mcp::mcp_send,
            mcp::mcp_kill,
            zoom::set_zoom,
            tts::melo_status,
            tts::melo_download,
            tts::melo_import,
            tts::melo_cancel_install,
            tts::melo_delete,
            tts::melo_begin_speech,
            tts::melo_cancel_speech,
            tts::melo_synthesize
        ])
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<Arc<mcp::McpState>>().kill_all();
                app.state::<Arc<tts::TtsState>>().shutdown();
            }
        });
}
