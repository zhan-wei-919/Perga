//! `perga` Tauri 应用入口。
//!
//! 一窗口形态(终端 tab / split 在前端实现,Tauri 只给一个 webview 容器)。
//! Tauri command 在 `crate::commands::*` 定义;`AppState` 持有 session 注册表
//! 与 sandbox 路径。
//!
//! 角色:**production 入口**。打包后跑这一个二进制就够,perga-server 不再
//! 需要;dev 浏览器迭代仍可独立用 `cargo run -p perga-server` + `pnpm dev`。

mod commands;
mod paths;
mod session_registry;

use std::path::PathBuf;

use tauri::Manager;
use tracing_subscriber::EnvFilter;

use crate::session_registry::SessionRegistry;

/// 全局 app state。setup 阶段一次性解析路径并装进 `AppState`,各 command
/// 通过 `tauri::State` 取用。
pub struct AppState {
    pub registry: SessionRegistry,
    pub profiles_path: PathBuf,
    pub known_hosts_path: PathBuf,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    init_tracing();

    tauri::Builder::default()
        .setup(|app| {
            let resolved = paths::resolve(app.handle())?;
            tracing::info!(
                profiles = %resolved.profiles_path.display(),
                known_hosts = %resolved.known_hosts_path.display(),
                "perga.tauri.paths_resolved"
            );
            app.manage(AppState {
                registry: SessionRegistry::default(),
                profiles_path: resolved.profiles_path,
                known_hosts_path: resolved.known_hosts_path,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::profiles::list_hosts,
            commands::profiles::create_host,
            commands::profiles::update_host,
            commands::profiles::delete_host,
            commands::session::session_open,
            commands::session::session_input,
            commands::session::session_close,
            commands::platform::get_platform_info,
        ])
        .run(tauri::generate_context!())?;
    Ok(())
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn"));
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(filter)
        .init();
}
