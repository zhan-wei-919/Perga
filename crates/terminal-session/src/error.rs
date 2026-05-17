//! Session 层的领域错误。
//!
//! 故意**不**`#[from] PtyError` ── 上层不该看到 PTY 实现细节,只关心
//! 「PTY 启动失败,原因如下」。`PtyError` 的 source-chain 被 `Display`
//! 拍扁成字符串带在 `Spawn` 里;真要 root-cause 时 log 里有完整 chain。

use thiserror::Error;

#[derive(Debug, Error)]
pub enum SessionError {
    /// PTY 启动失败。`PtyConfig::program` 不存在、权限不足、内核拒发 fd 等。
    #[error("failed to spawn pty: {0}")]
    Spawn(String),
}
