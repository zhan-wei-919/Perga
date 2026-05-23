//! Perga PTY 层。
//!
//! 这一层只负责字节通路:启动 PTY + 子进程,把 PTY 输出原样向上传,把
//! 上层命令(写入 / resize / 关闭)原样向下传。**不做任何终端协议解析。**
//! 协议解析、grid 维护、snapshot/diff 编码全部留给上层。
//!
//! 与 [`transport`] 的关系:本 crate 实现 [`transport::Transport`],把
//! 本地 PTY 包成统一的 backend 接口,`terminal-session` 用 `Box<dyn Transport>`
//! 持有任意 backend(本地 PTY / SSH)。
//!
//! **移动 target**:Android / iOS 上没有可用的 fork+exec 用户进程通路,
//! `portable-pty` / `libc::killpg` 也不可链接。整个 crate 在这些 target
//! 上由顶部 `#![cfg(...)]` 编译为空,下游必须各自用 cfg 跳过 `use pty::*`。
//! 这是"防御边界" —— mobile 上 pty crate 存在但无导出。

#![cfg(not(any(target_os = "android", target_os = "ios")))]

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
