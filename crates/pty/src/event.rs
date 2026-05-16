//! PTY 线程 → 上层的事件流。
//!
//! 三条工作线程(reader / writer / waiter)共享同一个 `Sender<PtyEvent>`,
//! 上层只需消费一个 `Receiver<PtyEvent>` 即可拿到全部信号:数据、退出、错误。
//!
//! 事件序协议:
//! - `Output` 字节流可以出现 0 ~ N 次,顺序就是 PTY 的字节顺序。
//! - `Exited` **保证**是会话内最后一个事件,且发出时所有 `Output` 都已入 channel。
//!   waiter 用阻塞 recv 等 reader 线程的 done 信号实现这个保证。
//! - `Error` **只表示致命错误**,发出后对应线程会退出,上层应当视作会话终止。
//!   非致命问题(例如 resize 调用被内核临时拒绝)只走日志,不发 event。

use std::io;

use thiserror::Error;

#[derive(Debug)]
pub enum PtyEvent {
    /// PTY 原始字节,不解析。
    Output(Vec<u8>),
    /// 子进程已退出。**最后一个事件**,后续不会再有 Output / Error。
    Exited(ExitStatus),
    /// 致命错误。发出后对应线程会退出,会话视作不可用。
    Error(PtyError),
}

/// 子进程退出状态。这里做了一层薄封装,避免直接泄漏 `portable_pty::ExitStatus`。
///
/// 第一刀只关心 exit code 和成功标志,不暴露平台信号语义。等到协议编码
/// 层需要把信号信息传给前端时再扩展。
#[derive(Debug, Clone, Copy)]
pub struct ExitStatus {
    pub code: u32,
    pub success: bool,
}

impl From<portable_pty::ExitStatus> for ExitStatus {
    fn from(s: portable_pty::ExitStatus) -> Self {
        Self {
            code: s.exit_code(),
            success: s.success(),
        }
    }
}

#[derive(Error, Debug)]
pub enum PtyError {
    #[error("spawn failed: {0}")]
    Spawn(String),
    #[error("pty read error")]
    Read(#[source] io::Error),
    #[error("pty write error")]
    Write(#[source] io::Error),
    #[error("wait child error: {0}")]
    Wait(String),
}
