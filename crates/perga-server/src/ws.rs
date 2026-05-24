//! WebSocket 端点:`GET /ws?rows=R&cols=C[&profile=<id>]`。
//!
//! 一连接一会话。WS 升级**之后**同步创建 `TerminalSession`(本地 PTY 或 SSH),
//! 关闭时同步释放。
//!
//! `profile` query 参数缺省 → 本地 shell;指定 → 走 SSH backend。SSH 路径在
//! WS upgrade **之后**完成 connect + auth + open shell;**失败时通过 WS 发
//! 一条 `SessionError` 事件再 close**。这样前端 pane 能看到具体错误原因
//! (host key mismatch / auth failed / profile not found 等),而不是
//! 浏览器 `onerror` 后只看到泛泛的 close —— WebSocket API 不暴露 HTTP
//! status/body 给 JS,所以 upgrade 之前的 4xx/5xx 对用户是不可见的。
//!
//! 仍**之前**走 HTTP 错误的:只有纯语法错误(size 越界),WS upgrade 还没
//! 发生时就拦下,客户端能在 fetch 路径(将来重连尝试 / 调试)拿到清晰 status。
//!
//! # 线程模型
//!
//! ```text
//!  backend(PTY 子进程 / SSH channel)
//!     │ bytes
//!     ▼
//!  engine_thread (sync)            ← TerminalSession 内部线程
//!     │ ProtocolEvent (crossbeam)
//!     ▼
//!  perga-event-bridge (OS thread)  ← bridge::spawn_event_bridge
//!     │ ProtocolEvent (tokio mpsc)
//!     ▼
//!  tx_fut (tokio)                  ← 序列化 JSON,推 WS
//!
//!  WS (tokio) ──► rx_fut ──► session.input() (crossbeam) ──► engine_thread
//! ```
//!
//! `perga-event-bridge` 仍然是整条 server 路径上唯一的 sync↔async 缝合点
//! (CLAUDE.md §运行时模型)。SSH backend 自带一组 OS 线程驱动 russh,但那
//! 是 `crates/ssh` 内部的事,对 server 层不可见。

use std::env;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::Query;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use futures_util::stream::StreamExt;
use futures_util::SinkExt;
use perga_core::profiles::{find_profile, load_profiles};
use perga_core::session_factory::{open_local, open_ssh};
use perga_core::wire::ClientMessage;
use serde::Deserialize;
use terminal_protocol::ProtocolEncoder;
use terminal_session::TerminalSession;
use transport::TerminalSize;

use crate::bridge::spawn_event_bridge;

/// query 参数。`rows` / `cols` 严格 > 0;上限 1000 是 sanity ── 没人开
/// 65535 列,允许过大的值反而会让 alacritty 内部分配巨型 grid。
/// `profile` 可选 —— 缺省 = 本地 shell,指定 = 走 SSH backend(由 server
/// 的 profile store 翻译成 SshConfig)。
#[derive(Debug, Clone, Deserialize)]
pub struct SessionParams {
    pub rows: u16,
    pub cols: u16,
    pub profile: Option<String>,
}

/// axum handler 入口。**只有 size 越界这种纯语法错误**会在 WS upgrade 之前
/// 返 HTTP 400;其他所有错误(profile 不存在、SSH connect 失败、本地 PTY
/// spawn 失败)都在 upgrade 之后通过 WS 发 `SessionError` 事件再 close ──
/// 浏览器 WebSocket API 不暴露 HTTP body 给 JS,只有走 WS 才能让用户看到
/// 具体原因。
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<SessionParams>,
) -> Result<axum::response::Response, (StatusCode, String)> {
    let (rows, cols) =
        validate_size(params.rows, params.cols).map_err(|msg| (StatusCode::BAD_REQUEST, msg))?;
    let size = TerminalSize::new(rows, cols);
    let profile_id = params.profile;

    Ok(ws
        .on_upgrade(move |socket| handle_upgraded(socket, size, profile_id))
        .into_response())
}

/// 1 <= size <= 1000。
fn validate_size(rows: u16, cols: u16) -> Result<(u16, u16), String> {
    if !(1..=1000).contains(&rows) {
        return Err(format!("rows must be in 1..=1000, got {rows}"));
    }
    if !(1..=1000).contains(&cols) {
        return Err(format!("cols must be in 1..=1000, got {cols}"));
    }
    Ok((rows, cols))
}

/// upgrade 后的入口:决定起 local 还是 SSH backend,失败通过 WS 发
/// `SessionError` 再 close;成功转入 `handle_socket` 跑双工循环。
async fn handle_upgraded(socket: WebSocket, size: TerminalSize, profile_id: Option<String>) {
    let spawned = match profile_id.as_deref() {
        None => spawn_local_blocking(size).await,
        Some(id) => spawn_ssh_blocking(id, size).await,
    };
    match spawned {
        Ok(session) => handle_socket(socket, session).await,
        Err(reason) => send_session_error_and_close(socket, reason).await,
    }
}

/// 发 SessionError + 关 WS。**不**等任何后续 IO,失败也无所谓 ── pane 那边
/// 收到 close 也会把 error 标志置位(详见前端 reducer)。
async fn send_session_error_and_close(mut socket: WebSocket, reason: String) {
    let event = ProtocolEncoder::new().encode_session_error(reason);
    match serde_json::to_string(&event) {
        Ok(json) => {
            let _ = socket.send(Message::Text(json)).await;
        }
        Err(e) => {
            // ProtocolEvent 全字段都是 derive(Serialize) 的 plain types,
            // 实际不会触发;若真出现就在日志里留痕。
            tracing::error!(error = %e, "perga.server.encode_session_error_failed");
        }
    }
    let _ = socket.close().await;
}

/// 本地 PTY 路径:spawn_blocking 跑 fork + exec + shell 集成注入。
/// 错误以 `String` 返回,由 `handle_upgraded` 翻成 SessionError。
async fn spawn_local_blocking(size: TerminalSize) -> Result<TerminalSession, String> {
    tokio::task::spawn_blocking(move || -> Result<TerminalSession, String> {
        let cwd = env::current_dir().ok();
        open_local(size, cwd).map_err(|e| format!("{e}"))
    })
    .await
    .map_err(|e| format!("spawn task panicked: {e}"))?
}

/// SSH 路径:同步加载 profile + 翻译 + 同步 SshSession::spawn(内部 block_on
/// connect/auth/shell)+ 包成 TerminalSession。整段放在 spawn_blocking 上 —
/// connect/auth 可能要几百 ms 量级,不该在 tokio worker 上跑。错误以 `String`
/// 返回,由 `handle_upgraded` 翻成 SessionError。
async fn spawn_ssh_blocking(id: &str, size: TerminalSize) -> Result<TerminalSession, String> {
    // profile 解析 / 查找在 spawn_blocking 外做 —— 文件读 / toml 解析也是 IO,
    // 但耗时 µs 量级,不必单开 blocking task。
    let profiles = load_profiles().map_err(|e| format!("load host profiles: {e}"))?;
    let profile = find_profile(&profiles, id).ok_or_else(|| {
        format!("host profile '{id}' not found in ~/.perga/hosts.toml; 在设置面板里检查 host 列表")
    })?;

    tokio::task::spawn_blocking(move || -> Result<TerminalSession, String> {
        // known_hosts_path = None 让 ssh crate 走 `~/.ssh/known_hosts`(桌面默认)。
        // 后续原生客户端若需要沙盒路径,由对应 IPC wrapper 传入显式路径。
        open_ssh(&profile, size, None).map_err(|e| format!("{e}"))
    })
    .await
    .map_err(|e| format!("spawn task panicked: {e}"))?
}

/// 升级后的实际双工循环。任一方向结束都拆掉整条会话。
async fn handle_socket(socket: WebSocket, session: TerminalSession) {
    // event_rx 是 crossbeam Receiver,Clone 后形成同一 channel 的多个消费者
    // handle。**只**让 bridge 线程对这个 clone 调 recv,session 自带的那个
    // receiver 不再被任何人 recv —— 多个 receiver 共存安全,只要单一消费。
    let event_rx_clone = session.events().clone();
    let input_tx = session.input().clone();

    let mut events_rx = match spawn_event_bridge(event_rx_clone) {
        Ok(rx) => rx,
        Err(e) => {
            tracing::error!(error = %e, "perga.server.bridge_spawn_failed");
            // 即便 bridge 起不来,session Drop 也会把 backend 收拾干净。
            drop_session_blocking(session).await;
            return;
        }
    };

    let (mut ws_tx, mut ws_rx) = socket.split();

    // outbound: events → WS text frames。
    let tx_fut = async move {
        while let Some(ev) = events_rx.recv().await {
            // serde_json 失败只可能是不可序列化的字段;ProtocolEvent 全字段
            // 都是 derive(Serialize) 的 plain types,实际不会触发。但仍按
            // CLAUDE.md「不静默吞错」记 warn 并停止 ── 协议帧丢了下游恢复不了。
            let json = match serde_json::to_string(&ev) {
                Ok(s) => s,
                Err(e) => {
                    tracing::error!(error = %e, "perga.server.encode_event_failed");
                    break;
                }
            };
            if ws_tx.send(Message::Text(json)).await.is_err() {
                break;
            }
        }
        // bridge 关闭 / WS 写失败 → 走完循环,close frame 由 axum 自动补。
    };

    // inbound: WS → session.input。
    let rx_fut = async move {
        while let Some(frame) = ws_rx.next().await {
            let msg = match frame {
                Ok(m) => m,
                Err(e) => {
                    tracing::warn!(error = %e, "perga.server.ws_recv_failed");
                    break;
                }
            };
            match msg {
                Message::Text(text) => match serde_json::from_str::<ClientMessage>(&text) {
                    Ok(cm) => {
                        if input_tx.send(cm.into_session_input()).is_err() {
                            // engine 线程已退 ── session 也快被 drop。
                            break;
                        }
                    }
                    Err(e) => {
                        // 单条坏帧不 kill 连接 ── 前端 retry 一条好帧就恢复。
                        tracing::warn!(
                            error = %e,
                            payload = %text,
                            "perga.server.invalid_client_message"
                        );
                    }
                },
                Message::Binary(_) => {
                    tracing::warn!("perga.server.binary_frame_ignored");
                }
                Message::Close(_) => break,
                // Ping/Pong 由 axum 自动处理,这里 fall through。
                Message::Ping(_) | Message::Pong(_) => {}
            }
        }
    };

    // tokio::select 在任一方向先完成时同时 drop 另一边 ── 跨 await 取消,
    // 等价于显式 abort。两端共享 session 通过 split:input_tx clone 在 rx_fut
    // 内、events_rx 在 tx_fut 内,select 退出后两者都被 drop。
    tokio::pin!(tx_fut);
    tokio::pin!(rx_fut);
    tokio::select! {
        _ = &mut tx_fut => {}
        _ = &mut rx_fut => {}
    }

    drop_session_blocking(session).await;
}

/// TerminalSession::Drop 会同步 join PTY / SSH 内部线程 + engine 线程,可能耗时
/// 数十 ms 量级。在 tokio 任务里直接 drop 会卡住 worker,丢到 spawn_blocking
/// 上去执行,await 的 panic 在 server 关停场景下吞掉(已经收尾了,不再传播)。
async fn drop_session_blocking(session: TerminalSession) {
    if let Err(e) = tokio::task::spawn_blocking(move || drop(session)).await {
        tracing::warn!(error = %e, "perga.server.session_drop_join_failed");
    }
}
