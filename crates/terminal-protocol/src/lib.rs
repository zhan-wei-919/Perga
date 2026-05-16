//! Terminal Engine 之上的协议编码层。
//!
//! 把 `terminal-engine` 暴露的 `Snapshot / TerminalModes / title` 翻译成
//! 跨进程消息(`ProtocolEvent`),供 Tauri / IPC / 其他传输层序列化后发给
//! 前端 webview。
//!
//! 设计要点:
//! - 顶层 `ProtocolEvent` 用 `#[serde(tag = "type")]`,前端 switch(msg.type)
//!   走不同分支。
//! - `Init` 是完整帧(首次 + resize 后),`Patch` 是行级增量,`Exited` 是
//!   子进程退出。
//! - `ProtocolEncoder` 持有上一帧缓存,自己做行级 diff;**不**碰 alacritty
//!   damage API,Engine 边界保持纯净。
//! - Encoder 不做 IO,只产 events。序列化(serde_json / MessagePack / 其他)
//!   和 emit(Tauri / WebSocket / 其他)都是上层的事。

mod encoder;
mod event;

pub use encoder::ProtocolEncoder;
pub use event::{DirtyRow, ExitStatus, ProtocolEvent, TitleChange};
