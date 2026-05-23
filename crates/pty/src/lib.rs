//! Perga PTY 层。
//!
//! 这一层只负责字节通路:启动 PTY + 子进程,把 PTY 输出原样向上传,把
//! 上层命令(写入 / resize / 关闭)原样向下传。**不做任何终端协议解析。**
//! 协议解析、grid 维护、snapshot/diff 编码全部留给上层。
//!
//! 与 [`transport`] 的关系:本 crate 实现 [`transport::Transport`],把
//! 本地 PTY 包成统一的 backend 接口,`terminal-session` 用 `Box<dyn Transport>`
//! 持有任意 backend(本地 PTY / SSH)。

mod command;
mod config;
mod event;
mod session;
mod shell_inject;
mod threads;

pub use command::TransportCommand;
pub use config::{default_shell, PtyConfig};
pub use event::PtyError;
pub use session::PtySession;
pub use shell_inject::inject_shell_integration;
// transport::TerminalSize / TransportEvent / ExitStatus 由上层直接用 transport
// 名字导入,这里不再 re-export,避免一份类型两个路径让人犹豫。
