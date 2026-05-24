//! `perga-core`:Perga 后端的协议无关核心。
//!
//! 把「与 axum / 平台 UI 无关」的逻辑提取在这里,供 `perga-server`、后续
//! `perga-core-daemon` 和原生客户端 IPC wrapper 复用。三块内容:
//!
//! - [`profiles`]:host profile schema + `~/.perga/hosts.toml` 读写。文件路径
//!   可由调用方注入(`*_at(path)` 系列),适配平台 sandbox / app data 目录。
//! - [`wire`]:client → backend 的 `ClientMessage` enum 反序列化层。WebSocket
//!   / IPC / HTTP wrapper 都直接消费同一份 schema。
//! - [`session_factory`]:`TerminalSession` 的同步开局工厂(本地 PTY / SSH)。
//!   Caller 拿到的是与 PTY / SSH 完全一致的 sync-first 句柄(`crates/transport`
//!   trait 已统一)。

pub mod profiles;
pub mod session_factory;
pub mod wire;
