//! Server 层领域错误。
//!
//! 故意**不**把 `SessionError` `#[from]` 进来 ── 上层 axum handler 只关心
//! 「这次 WS 升级该返回什么 HTTP 状态」,不关心底层 PTY / engine 细节。
//! 真要 root-cause,tracing 日志里有完整 source chain。

use thiserror::Error;

#[derive(Debug, Error)]
pub enum ServerError {
    /// `?rows` / `?cols` 缺失或不在合法范围。1-indexed 网格,0 没意义,
    /// 上限 1000 也只是 sanity ── 真实终端没人开 65535 列。
    #[error("invalid terminal size: {0}")]
    BadSize(String),

    /// PTY 启动失败。`SessionError::Spawn` 的字符串被透传过来。
    #[error("failed to spawn session: {0}")]
    Spawn(String),
}
