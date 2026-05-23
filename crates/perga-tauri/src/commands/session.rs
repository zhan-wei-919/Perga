//! Session lifecycle command:`session_open` / `session_input` / `session_close`。
//!
//! 取代 perga-server 的 `/ws` 端点。每个前端 leaf 先生成 `session_id` 并
//! `listen('session_event:<id>', ...)`,再调用 `session_open`;输入走
//! `session_input(session_id, msg)`,关 leaf 时调 `session_close(session_id)`。
//!
//! 错误返回带前缀的 String,前端按前缀分类(`bad_request:` / `size:` /
//! `not_found:` / `local:` / `local_unavailable:` / `ssh:` / `io:`)。
//! `local_unavailable:` 是 mobile target 的边界防御:本地 shell 不可用,
//! 前端 `pane_leaf.tsx` 的 `SessionErrorBanner` 直接展示这条字符串。

use perga_core::profiles::{find_profile, load_profiles_from};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use perga_core::session_factory::open_local;
use perga_core::session_factory::open_ssh;
use perga_core::wire::ClientMessage;
use tauri::{Emitter, State};
use terminal_session::TerminalSession;
use transport::TerminalSize;

use crate::session_registry::SessionEntry;
use crate::AppState;

#[tauri::command]
pub async fn session_open(
    app: tauri::AppHandle,
    session_id: String,
    profile_id: Option<String>,
    rows: u16,
    cols: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    uuid::Uuid::parse_str(&session_id)
        .map_err(|_| "bad_request:session_id must be a UUID".to_string())?;
    if !(1..=1000).contains(&rows) || !(1..=1000).contains(&cols) {
        return Err(format!(
            "size:rows/cols must be in 1..=1000, got rows={rows} cols={cols}"
        ));
    }
    let size = TerminalSize::new(rows, cols);
    let profiles_path = state.profiles_path.clone();
    let known_hosts_path = state.known_hosts_path.clone();

    // Open 全程同步阻塞(connect/auth 可能 几百 ms),用 spawn_blocking 隔离。
    let session: TerminalSession = tokio::task::spawn_blocking(move || -> Result<_, String> {
        match profile_id {
            None => open_local_arm(size),
            Some(id) => {
                let profiles = load_profiles_from(&profiles_path).map_err(|e| format!("io:{e}"))?;
                let profile = find_profile(&profiles, &id).ok_or_else(|| {
                    format!("not_found:host profile '{id}' not found in hosts.toml")
                })?;
                open_ssh(&profile, size, Some(known_hosts_path)).map_err(|e| format!("ssh:{e}"))
            }
        }
    })
    .await
    .map_err(|e| format!("io:spawn_blocking joined: {e}"))??;

    // Emit 线程在 OS 线程上跑,recv 阻塞;crossbeam Receiver clone 拿副本,session 自带的不动。
    let event_rx = session.events().clone();
    let input_tx = session.input().clone();
    let app_for_thread = app.clone();
    let event_name = format!("session_event:{session_id}");

    let emit_thread = std::thread::Builder::new()
        .name(format!(
            "perga-emit-{}",
            &session_id[..8.min(session_id.len())]
        ))
        .spawn(move || emit_loop(app_for_thread, event_name, event_rx))
        .map_err(|e| format!("io:spawn emit thread: {e}"))?;

    state.registry.insert(
        session_id.clone(),
        SessionEntry::new(session, input_tx, emit_thread),
    );
    Ok(())
}

/// `profile_id == None` 分支的实现:桌面起本地 PTY,移动 target 返回明确错误。
///
/// 抽出 helper 而不是在 match arm 里写 cfg,是为了让 match 表达式签名一致 ——
/// 两个 target 下 `None =>` 都是 `Result<TerminalSession, String>`。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn open_local_arm(size: TerminalSize) -> Result<TerminalSession, String> {
    // 打包后 current_dir 取决于启动器;本地 shell 默认从 HOME 起步更符合终端预期。
    let cwd = std::env::var_os("HOME").map(std::path::PathBuf::from);
    open_local(size, cwd).map_err(|e| format!("local:{e}"))
}

/// 移动 target 边界防御:本地 shell 在 Android / iOS 沙箱内不可达。
///
/// 前端在 zero-tab UX 闭环后实际不会发 `profile_id = None`(picker 强制选
/// 远程 profile)。这条 Err 是 defensive boundary,真要被命中说明前端 bug。
/// `local_unavailable:` 前缀被 `web/src/ui/pane_leaf.tsx::SessionErrorBanner`
/// 直接展示给用户。
#[cfg(any(target_os = "android", target_os = "ios"))]
fn open_local_arm(_size: TerminalSize) -> Result<TerminalSession, String> {
    Err("local_unavailable:local shell not available on mobile build".to_string())
}

#[tauri::command]
pub fn session_input(
    session_id: String,
    msg: ClientMessage,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let entry = state
        .registry
        .get(&session_id)
        .ok_or_else(|| format!("not_found:session {session_id}"))?;
    entry
        .input_tx()
        .send(msg.into_session_input())
        .map_err(|e| format!("io:send to session: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn session_close(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let entry = state
        .registry
        .remove(&session_id)
        .ok_or_else(|| format!("not_found:session {session_id}"))?;
    // close_blocking 走 TerminalSession::Drop(engine join + transport close),可能耗时
    // 数十 ms。spawn_blocking 隔离避免卡 tokio worker。
    tokio::task::spawn_blocking(move || entry.close_blocking())
        .await
        .map_err(|e| format!("io:close blocking joined: {e}"))?;
    Ok(())
}

/// Emit 循环主体。提出来主要是为可读 — 把循环退出条件集中在一处。
fn emit_loop(
    app: tauri::AppHandle,
    event_name: String,
    event_rx: crossbeam_channel::Receiver<terminal_protocol::ProtocolEvent>,
) {
    while let Ok(ev) = event_rx.recv() {
        if let Err(e) = app.emit(&event_name, &ev) {
            tracing::warn!(event = %event_name, error = %e, "perga.tauri.emit_failed");
            break;
        }
    }
    // event_rx 断开 / emit 失败 → 退出循环。线程函数返回 = 自然 join。
}
