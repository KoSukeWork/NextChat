// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bundled_plugins;
mod claude_cli;
mod claude_cli_events;
mod claude_cli_mcp;
mod claude_cli_sessions;
mod claude_cli_tauri;
mod mcp;
mod mcp_oauth;
#[cfg(windows)]
mod process_job;
mod stream;
mod sync_http;
mod tts;
#[cfg(windows)]
mod window_icon;
mod zoom;
use std::sync::Arc;
use tauri::Manager;

fn main() {
    let mut context = tauri::generate_context!();
    // Tests can isolate all Tauri config/state paths as well as WebView2 and MCP.
    // No path changes when this explicit environment variable is absent.
    if let Some(directory) = std::env::var_os("NEXTCHAT_TEST_APP_DIR") {
        let directory = std::path::PathBuf::from(directory);
        assert!(
            directory.is_absolute(),
            "NEXTCHAT_TEST_APP_DIR must be absolute"
        );
        context.config_mut().tauri.bundle.identifier = directory.to_string_lossy().into_owned();
    }
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(windows)]
            app.manage(window_icon::set_window_icons(app.windows().values()));
            let directory = app
                .path_resolver()
                .app_config_dir()
                .ok_or("Missing application config directory")?;
            std::fs::create_dir_all(&directory)?;
            // Generic filesystem IPC (including save-dialog grants) must not bypass MCP approval.
            app.fs_scope().forbid_directory(&directory, true)?;
            let mcp_directory =
                mcp::config_directory(&directory, std::env::var_os("NEXTCHAT_MCP_CONFIG_DIR"))?;
            std::fs::create_dir_all(&mcp_directory)?;
            app.fs_scope().forbid_directory(&mcp_directory, true)?;
            app.manage(Arc::new(mcp::McpState::new(
                mcp_directory.join("mcp_config.json"),
            )));
            app.manage(Arc::new(mcp_oauth::OAuthCallbacks::default()));
            app.manage(Arc::new(stream::StreamState::default()));
            app.manage(Arc::new(claude_cli_tauri::CliApp::new(directory.join("local-services"))?));
            app.manage(tts::setup(app)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bundled_plugins::bundled_licenses,
            claude_cli_tauri::claude_cli_start,
            claude_cli_tauri::claude_cli_cancel,
            claude_cli_tauri::claude_cli_tool_result,
            claude_cli_tauri::claude_cli_status,
            claude_cli_tauri::claude_cli_configure,
            claude_cli_tauri::claude_cli_options,
            stream::stream_fetch,
            stream::stream_cancel,
            sync_http::sync_http,
            mcp::mcp_read_config,
            mcp::mcp_write_config,
            mcp::mcp_oauth_read,
            mcp::mcp_oauth_write,
            mcp::mcp_oauth_remove,
            mcp_oauth::mcp_oauth_listen,
            mcp_oauth::mcp_oauth_wait,
            mcp_oauth::mcp_oauth_cancel,
            mcp_oauth::mcp_oauth_open,
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
            tts::melo_synthesize,
        ])
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<Arc<mcp::McpState>>().kill_all();
                app.state::<Arc<tts::TtsState>>().shutdown();
                app.state::<Arc<claude_cli_tauri::CliApp>>().shutdown();
            }
        });
}

#[cfg(test)]
mod isolation_tests {
    #[test]
    fn absolute_test_directory_is_used_for_native_state_paths() {
        let mut context = tauri::generate_context!();
        let isolated = std::env::temp_dir().join("nextchat-isolation-check");
        context.config_mut().tauri.bundle.identifier = isolated.to_string_lossy().into_owned();
        assert_eq!(
            tauri::api::path::app_config_dir(context.config()),
            Some(isolated.clone())
        );
        assert_eq!(
            tauri::api::path::app_local_data_dir(context.config()),
            Some(isolated)
        );
    }
}
