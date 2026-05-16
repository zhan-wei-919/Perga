//! Perga PTY 层。
//!
//! 这一层只负责字节通路:启动 PTY + 子进程,把 PTY 输出原样向上传,把
//! 上层命令(写入 / resize / 关闭)原样向下传。**不做任何终端协议解析。**
//! 协议解析、grid 维护、snapshot/diff 编码全部留给上层。

mod command;
mod config;
mod event;
mod session;
mod threads;

pub use command::PtyCommand;
pub use config::{default_shell, PtyConfig, PtySize};
pub use event::{ExitStatus, PtyError, PtyEvent};
pub use session::PtySession;
