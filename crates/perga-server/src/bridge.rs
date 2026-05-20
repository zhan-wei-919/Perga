//! sync ↔ async 桥。
//!
//! `terminal-session` 的事件流是 crossbeam `Receiver<ProtocolEvent>`(同步、
//! 阻塞)。axum WS handler 跑在 tokio runtime,只能 await 一个异步源。
//!
//! 这个 crate 是 **整个 server 路径上唯一**接 tokio 的地方,缝合点在这里
//! 完成一次:专门 spawn 一条 OS 线程跑 `recv()`,把元素转发到 tokio mpsc。
//! PTY / engine / session 仍然全程 sync + crossbeam(见 CLAUDE.md §运行时模型)。
//!
//! # 寿命与关闭
//!
//! - 输入端(crossbeam sender)被 drop → 桥线程 `recv` 收到 `Disconnected` →
//!   退出循环 → tokio sender drop → 异步消费者 `recv().await` 返回 `None`。
//! - 异步消费者先关 → tokio `blocking_send` 返回 Err → 桥线程退出,sync 侧
//!   `Receiver` 仍由调用方持有,后续 `recv` 会再得到事件(如果还有);但
//!   实际场景下 ws handler 一旦结束就会同时 drop session,sync 侧也随之断开。
//!
//! 不在桥内做 backpressure ── tokio mpsc 用 unbounded,protocol event 总数
//! 受限于 PTY 输出节奏,unbounded 比手调 capacity 简单。真出现内存压力再上
//! bounded + drop-oldest 策略。

use crossbeam_channel::Receiver as CrossbeamReceiver;
use terminal_protocol::ProtocolEvent;
use tokio::sync::mpsc::UnboundedReceiver;

/// 起一条 OS 线程,把 sync `Receiver<ProtocolEvent>` 上的元素搬到 tokio mpsc。
///
/// 返回 tokio 侧的 `Receiver`,WS handler 直接 `.recv().await` 即可。桥线程
/// 自己负责退出:任一方向断开就结束。
pub fn spawn_event_bridge(
    sync_rx: CrossbeamReceiver<ProtocolEvent>,
) -> std::io::Result<UnboundedReceiver<ProtocolEvent>> {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<ProtocolEvent>();
    std::thread::Builder::new()
        .name("perga-event-bridge".into())
        .spawn(move || {
            // recv() 阻塞直到有元素或对端 disconnect。这里没有 select,只有一条
            // 单向数据流,逻辑简单:有元素就转发,转发失败就退,recv 失败也退。
            while let Ok(ev) = sync_rx.recv() {
                if tx.send(ev).is_err() {
                    // 异步消费者已 drop。桥线程使命结束。
                    break;
                }
            }
            // 函数返回时 tx 自动 drop ── 异步侧 recv().await 立刻得到 None,
            // WS handler 据此结束 send 循环。
        })?;
    Ok(rx)
}
