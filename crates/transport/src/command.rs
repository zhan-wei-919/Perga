//! 上层 → backend 线程的命令枚举。
//!
//! 按 CLAUDE.md「线程间通信」节,用一个命令枚举承载多种意图,不为
//! Resize / Shutdown 单拆 channel —— 它们和 Write 的优先级、背压都一致。

use crate::size::TerminalSize;

/// 一条要 backend 执行的命令。
///
/// 形状同时适用本地 PTY 和 SSH:
/// - `Write`:字节原样写入(本地 = master fd write;SSH = `channel.data`)。
/// - `Resize`:终端窗口尺寸变化(本地 = SIGWINCH;SSH = `window_change` request)。
/// - `Shutdown`:主动关闭会话。本地走 SIGHUP → grace → SIGKILL pgroup;
///   SSH 走 close channel + disconnect。
#[derive(Debug, Clone)]
pub enum TransportCommand {
    Write(Vec<u8>),
    Resize(TerminalSize),
    Shutdown,
}
