//! 终端 backend 与 session 缝合层之间的共享接口。
//!
//! 这一层只放**类型和 trait**,不做 IO。所有产生终端字节流的 backend
//! (本地 [`pty`] / 远端 [`ssh`])都实现 [`Transport`],由
//! `terminal-session` 通过 `Box<dyn Transport>` 一视同仁地驱动 engine 线程。
//!
//! 设计要点:
//! - [`TransportCommand`] / [`TransportEvent`] 的形状对本地 PTY 和 SSH channel
//!   都适用 —— 双方都用 bytes 写入 + Resize + Exited 这套语义。
//! - 同步阻塞 channel(`crossbeam_channel`),**不**引入 async。SSH backend
//!   内部需要 tokio runtime,但仍以同步 channel 对外暴露(见 CLAUDE.md
//!   §运行时模型)。

mod command;
mod event;
mod size;
mod transport;

pub use command::TransportCommand;
pub use event::{ExitStatus, TransportError, TransportEvent};
pub use size::TerminalSize;
pub use transport::Transport;
