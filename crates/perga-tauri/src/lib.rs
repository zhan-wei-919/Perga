//! `perga_lib` Tauri 应用入口 lib。
//!
//! 桌面 `bin/perga` 和移动 `cdylib` 共用同一份 `run()`。Tauri mobile
//! 通过 `#[cfg_attr(mobile, tauri::mobile_entry_point)]` 把 `run` 标成
//! Android NativeActivity / iOS App lifecycle 的入口点;桌面 `main.rs` 直接调。
//!
//! 一窗口形态(终端 tab / split 在前端实现,Tauri 只给一个 webview 容器)。
//! Tauri command 在 `crate::commands::*` 定义;`AppState` 持有 session 注册表
//! 与 sandbox 路径。
//!
//! 角色:**production 入口**。打包后跑这一个二进制(或加载这个 cdylib)就够,
//! perga-server 不再需要;dev 浏览器迭代仍可独立用 `cargo run -p perga-server`
//! + `pnpm dev`。

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

/// Tauri 应用真正入口逻辑。返回 `Result` 让 caller 选错误处理路径
/// ── desktop bin `main` 自己 propagate;mobile [`run`] wrapper 内部 abort。
///
/// 拆出 `try_run` 的原因:`#[tauri::mobile_entry_point]` 宏装在
/// `pub fn run()`(无返回值)上,**返回值会被吞掉**。把可失败逻辑
/// 放在 `try_run` 让两条入口都能看到错误。
pub fn try_run() -> Result<(), Box<dyn std::error::Error>> {
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

/// Mobile entry point:`#[cfg_attr(mobile, tauri::mobile_entry_point)]`
/// 要求函数签名是 `fn() -> ()`,所以这里**内部**处理错误 ── 否则 Android /
/// iOS 启动失败会被宏静默吃掉,进程留着但 webview 空白。
///
/// 桌面 bin `main.rs` 不走这里,直接调用 [`try_run`] 自己处理错误。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Err(e) = try_run() {
        // 在 Android 上 stderr 通过 logcat 抓:`adb logcat | grep perga`。
        // iOS 走 syslog。用 `exit(1)` 而不是 panic ── 让平台拿到明确非零
        // 退出码,不会被 webview 留着空白窗口。
        eprintln!("perga: fatal: {e}");
        std::process::exit(1);
    }
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn"));
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(filter)
        .init();
}
