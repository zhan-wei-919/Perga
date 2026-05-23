//! Perga SSH backend。
//!
//! 用 [`russh`] 直连远端 SSH 服务器(不 spawn `ssh` 子进程,iPad / Android
//! Tauri 沙箱也能用)。对外实现 [`transport::Transport`] —— 同步 crossbeam
//! channel 接口,和本地 [`pty::PtySession`] 完全一致,`terminal-session`
//! 通过 `Box<dyn Transport>` 一视同仁地驱动。
//!
//! 运行时模型(见 CLAUDE.md §运行时模型):
//! - russh 本身是 async,本 crate **内部**起一个 `current_thread` tokio runtime
//!   作为 side pool,在专用 OS 线程上 `block_on` shuttle loop。
//! - PTY / engine / session 路径**不**进 tokio,继续 sync + crossbeam。
//! - 跨 sync ↔ async 边界两处:命令通路(crossbeam → tokio mpsc 通过一条 bridge
//!   OS 线程转发)与事件通路(shuttle loop 内部从 tokio 直接 send 到 crossbeam
//!   Sender —— crossbeam send unbounded 不阻塞,无需另起线程)。
//!
//! v1 范围(见 `docs/state-2026-05-23.md` §9 / `~/.claude/plans/sunny-conjuring-quasar.md`):
//! - Auth:**agent only**(`SSH_AUTH_SOCK`)。
//! - Host key:**静默 TOFU** on `~/.ssh/known_hosts`。
//! - 不做 password / 2FA / jump host / agent forwarding / passphrase key file。

mod config;
mod error;
mod handler;
mod session;
mod shuttle;

pub use config::{Auth, SshConfig};
pub use error::SshError;
pub use session::SshSession;
