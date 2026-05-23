//! SSH backend 的领域错误。
//!
//! 故意**不**`#[from] russh::Error` —— 上层(`perga-server` / `terminal-session`)
//! 不该看到 russh 内部实现细节,只关心「这一步出了什么类别的错」。
//! `russh::Error` 的 Display 链路被拍扁成字符串带走,真要 root-cause 时
//! 看 tracing 日志。

use thiserror::Error;

#[derive(Error, Debug)]
pub enum SshError {
    /// TCP / 版本协商 / kex 阶段失败。host 不可达 / DNS / 网络中断等。
    #[error("ssh connect failed: {0}")]
    Connect(String),

    /// host key 校验失败 —— known_hosts 里有记录但 fingerprint 不匹配。
    /// 真实的安全信号,**不**自动接受:用户需要核对后手动处理。
    #[error("ssh host key mismatch (known_hosts entry has different fingerprint; manual intervention required)")]
    HostKeyMismatch,

    /// 认证失败:agent 不存在 / 没有 identity / 所有 identity 都被服务端拒绝。
    #[error("ssh auth failed: {0}")]
    Auth(String),

    /// 开 channel / request_pty / request_shell 失败。
    #[error("ssh channel setup failed: {0}")]
    Channel(String),

    /// IO / 运行时构造错误(`tokio::runtime::Builder::build` 失败、
    /// 线程 spawn 失败等)。
    #[error("ssh io error: {0}")]
    Io(String),
}
