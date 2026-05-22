//! WebSocket 端点:`GET /ws?rows=R&cols=C`。
//!
//! 一连接一会话。WS 升级时同步创建 `TerminalSession`,WS 关闭时同步释放。
//! Phase 0 没有 reconnect / 多 subscriber:省掉 registry,会话 owner 就是
//! 这个 handler。多 tab / 多 pane 通过开多条 WS 连接实现(每条独立的
//! TerminalSession,前端自己管 id 映射)。
//!
//! # 线程模型
//!
//! ```text
//!  PTY 子进程
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
//! 整条路径上只有 `perga-event-bridge` 这一处把 sync 转 async,其他全部是
//! 各自世界里的标准模式(见 CLAUDE.md §运行时模型)。

use std::env;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::Query;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use futures_util::stream::StreamExt;
use futures_util::SinkExt;
use pty::{inject_shell_integration, PtyConfig, PtySize};
use serde::Deserialize;
use terminal_session::TerminalSession;

use crate::bridge::spawn_event_bridge;
use crate::wire::ClientMessage;

/// query 参数。`rows` / `cols` 严格 > 0;上限 1000 是 sanity ── 没人开
/// 65535 列,允许过大的值反而会让 alacritty 内部分配巨型 grid。
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct SessionParams {
    pub rows: u16,
    pub cols: u16,
}

/// axum handler 入口。size 校验失败直接返回 400;TerminalSession spawn 失败
/// 返回 500。两者都不进入 WS 升级路径。
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<SessionParams>,
) -> Result<axum::response::Response, (StatusCode, String)> {
    let (rows, cols) =
        validate_size(params.rows, params.cols).map_err(|msg| (StatusCode::BAD_REQUEST, msg))?;

    // PtyConfig::with_default_shell 读 $SHELL,继承当前 cwd。
    // 放到 spawn_blocking 是因为 PtySession::spawn 内部会 fork + exec,
    // 严格说不算长阻塞,但仍要避开 async runtime 的 cooperative scheduler。
    // inject_shell_integration 也写集成文件,一并留在 blocking 线程上。
    let session = tokio::task::spawn_blocking(move || -> Result<TerminalSession, String> {
        let mut cfg = PtyConfig::with_default_shell(PtySize::new(rows, cols));
        cfg.cwd = env::current_dir().ok();
        inject_shell_integration(&mut cfg);
        TerminalSession::spawn(cfg).map_err(|e| format!("{e}"))
    })
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("spawn task panicked: {e}"),
        )
    })?
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(ws
        .on_upgrade(move |socket| handle_socket(socket, session))
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
            // 即便 bridge 起不来,session Drop 也会把 PTY 收拾干净。
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

/// TerminalSession::Drop 会同步 join PTY 三条线程 + engine 线程,可能耗时
/// 数十 ms 量级。在 tokio 任务里直接 drop 会卡住 worker,丢到 spawn_blocking
/// 上去执行,await 的 panic 在 server 关停场景下吞掉(已经收尾了,不再传播)。
async fn drop_session_blocking(session: TerminalSession) {
    if let Err(e) = tokio::task::spawn_blocking(move || drop(session)).await {
        tracing::warn!(error = %e, "perga.server.session_drop_join_failed");
    }
}
