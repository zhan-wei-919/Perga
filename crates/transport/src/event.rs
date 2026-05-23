//! Backend 线程 → 上层的事件流。
//!
//! 事件序契约(本地 PTY 和 SSH 都遵守):
//! - `Output` 字节流可以出现 0 ~ N 次,顺序就是 backend 产出顺序。
//! - `Exited` **保证**是会话内最后一个事件,且发出时所有 `Output` 都已入 channel。
//!   实现方需要保证读侧 buffer 排空后才发 `Exited`。
//! - `Error` **只表示致命错误**,发出后对应线程会退出,上层应当视作会话终止。
//!   非致命问题(如 resize 调用被内核临时拒绝)只走日志,不发 event。

use thiserror::Error;

#[derive(Debug)]
pub enum TransportEvent {
    /// Backend 产出的原始字节,不解析。
    Output(Vec<u8>),
    /// 远端 / 本地子进程已退出。**最后一个事件**,后续不会再有 Output / Error。
    Exited(ExitStatus),
    /// 致命错误。发出后对应线程会退出,会话视作不可用。
    Error(TransportError),
}

/// 终端会话退出状态。
///
/// `code` 与 `signal` 同时保留对齐 wire format —— 本地 PTY 当前只透 `code`,
/// signal 信息提取需要平台特定代码(`WIFSIGNALED` / `WTERMSIG`),v1 不做。
/// SSH 的 `ChannelMsg::ExitStatus` / `ChannelMsg::ExitSignal` 分两种 msg,
/// 落地时各填一边。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct ExitStatus {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

impl ExitStatus {
    pub const fn from_code(code: i32) -> Self {
        Self {
            code: Some(code),
            signal: None,
        }
    }

    pub const fn from_signal(signal: i32) -> Self {
        Self {
            code: None,
            signal: Some(signal),
        }
    }
}

/// Backend 内部产生的致命错误。
///
/// 故意**不**`#[from]` `io::Error` —— 不同 backend 的 IO 错误形态差异大
/// (PTY 是 fd EIO / EBADF,SSH 是 channel close + auth fail),
/// 用字符串吸收并保留 Display 链路就够了。具体诊断信息走 tracing 日志。
#[derive(Error, Debug)]
pub enum TransportError {
    #[error("transport read error: {0}")]
    Read(String),
    #[error("transport write error: {0}")]
    Write(String),
    #[error("transport wait error: {0}")]
    Wait(String),
}
