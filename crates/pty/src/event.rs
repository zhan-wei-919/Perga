//! PTY 线程 → 上层的事件 / 错误类型。
//!
//! 数据事件本身已统一到 `transport::TransportEvent`(Output / Exited / Error);
//! 本模块只保留 PTY 实现内部专有的错误类型 [`PtyError`](与 spawn 失败、PTY
//! IO 错误绑定),以及一个把 `portable_pty::ExitStatus` 翻成 transport 形态
//! 的辅助函数。
//!
//! 事件序契约见 [`transport::TransportEvent`] 的文档:Output 顺序就是 PTY
//! 字节顺序、Exited 是会话最后一个事件、Error 只表示致命错误。

use std::io;

use thiserror::Error;
use transport::ExitStatus;

/// 把 portable-pty 的 ExitStatus 翻成 transport 通用 [`ExitStatus`]。
///
/// `portable_pty::ExitStatus::exit_code()` 在 Unix 上是已经被 normalize 过的
/// u32:正常退出 = 0..=255,信号杀死 = 128 + signum(POSIX 约定)。signal 字段
/// 当前总是 None —— signal 拆分需要平台特定 `WIFSIGNALED` / `WTERMSIG`,v1 不做,
/// 等真有需要时在这里加一层。
pub fn exit_status_from_portable(s: portable_pty::ExitStatus) -> ExitStatus {
    // u32 → i32 转换:portable_pty 已经规整成 0..=255 + 128+signum 这种小整数,
    // 安全 cast,不会越界。i32::try_from 防御性兜底,理论上恒成功。
    let code = i32::try_from(s.exit_code()).ok();
    ExitStatus { code, signal: None }
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
