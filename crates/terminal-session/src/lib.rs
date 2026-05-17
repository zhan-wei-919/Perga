//! Session 缝合层。
//!
//! 把 `pty` / `terminal-engine` / `terminal-protocol` / `terminal-input` 四个
//! 纯逻辑层接成一条双向通路:
//!
//! ```text
//!   ┌─────────────────┐  SessionInput  ┌────────────┐  PtyCommand   ┌─────┐
//!   │ caller (Tauri / │ ─────────────► │  Engine    │ ────────────► │ PTY │
//!   │ tests / 其他)   │                │  thread    │               │     │
//!   │                 │ ◄───────────── │            │ ◄──────────── │     │
//!   └─────────────────┘  ProtocolEvent └────────────┘   PtyEvent    └─────┘
//! ```
//!
//! 引擎线程拥有 [`terminal_engine::TerminalEngine`] + [`terminal_protocol::ProtocolEncoder`],
//! 在两个 channel 之间 `select!`,**不**和外界共享可变状态。
//!
//! # 退出契约
//!
//! 消费者通过 `events().recv()` 返回 `Err(Disconnected)` 判断会话已结束;
//! 正常退出会先看到一条 [`terminal_protocol::ProtocolEvent::Exited`],随后
//! channel disconnect。引擎线程 panic 时不发 Exited,直接 disconnect,但
//! [`TerminalSession`] Drop 仍能正确清理 PTY 子进程。

mod error;
mod event_loop;
mod session;

pub use error::SessionError;
pub use session::{SessionInput, TerminalSession};
