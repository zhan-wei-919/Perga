//! [`russh::client::Handler`] 实现 —— 主要实现 `check_server_key` 的 TOFU 策略。
//!
//! 策略:
//! - known_hosts 里有匹配 entry → 直接接受。
//! - 不存在(从未连过这台 host)→ **自动写入** known_hosts,接受。这就是
//!   「静默 TOFU」:用户感知 = 「点了就连上」。
//! - 存在 entry 但 fingerprint 不匹配 → **拒绝**。这是真实的安全信号,不自动
//!   绕过。前端会收到一个清晰的 `HostKeyMismatch` 错误,提示用户去
//!   `~/.ssh/known_hosts` 删旧条目重新 TOFU(机器被合法重装)或意识到 MITM。
//!
//! 与 OpenSSH 的对比:OpenSSH 的 `StrictHostKeyChecking=accept-new` 等价于此处
//! 策略;默认的 `ask` 模式因为 GUI 不弹问题不适用。

use std::path::PathBuf;

use russh::keys::known_hosts::{check_known_hosts_path, learn_known_hosts_path};
use russh::keys::Error as KeysError;
use russh::keys::PublicKey;

/// 实现 `russh::client::Handler` 的最小 client handler。
pub(crate) struct PergaHandler {
    pub host: String,
    pub port: u16,
    pub known_hosts_path: PathBuf,
}

impl russh::client::Handler for PergaHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        match check_known_hosts_path(
            &self.host,
            self.port,
            server_public_key,
            &self.known_hosts_path,
        ) {
            // 已记录,fingerprint 匹配 → 接受。
            Ok(true) => Ok(true),
            // 没有这台 host 的记录 → TOFU 写入并接受。
            Ok(false) => match learn_known_hosts_path(
                &self.host,
                self.port,
                server_public_key,
                &self.known_hosts_path,
            ) {
                Ok(()) => Ok(true),
                Err(e) => {
                    // 写不进 known_hosts(权限 / 磁盘满 / 路径错)。继续连下去
                    // 会让下次连接还是「未知」状态,而且每次都试图写。这里直接
                    // 拒绝,把错误暴露给用户,比"看起来连上但安全状态退化"安全。
                    tracing::warn!(
                        host = %self.host,
                        path = %self.known_hosts_path.display(),
                        error = %e,
                        "ssh.handler.known_hosts_write_failed"
                    );
                    Ok(false)
                }
            },
            // 已记录但 fingerprint 不匹配 → 拒绝。**不绕过**:这是真实的
            // 安全信号(机器被换 / 真有 MITM),让上层报清楚错。
            Err(KeysError::KeyChanged { line }) => {
                tracing::warn!(
                    host = %self.host,
                    port = self.port,
                    known_hosts_line = line,
                    "ssh.handler.host_key_mismatch"
                );
                Ok(false)
            }
            // 其他错误(known_hosts 解析失败 / IO 错误)。拒绝并 log;
            // 不假装连接成功来掩盖配置问题。
            Err(e) => {
                tracing::warn!(
                    host = %self.host,
                    error = %e,
                    "ssh.handler.known_hosts_check_failed"
                );
                Ok(false)
            }
        }
    }
}
