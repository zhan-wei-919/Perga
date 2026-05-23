//! SSH 连接参数。
//!
//! 本 crate **不知道** profile 的概念:`perga-server::profiles` 负责把
//! 用户的 `~/.perga/hosts.toml` 翻译成 [`SshConfig`]。这样 Phase 6 Tauri 桌面 /
//! 移动端复用同一份 SSH 实现,不绑定 server 端的 profile schema。

use std::path::PathBuf;

/// 一次 SSH 会话的连接参数。
#[derive(Debug, Clone)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: Auth,
    /// known_hosts 文件路径。`None` = 默认 `~/.ssh/known_hosts`,
    /// 上层(`perga-server` / 测试)需要隔离时显式指定。
    pub known_hosts_path: Option<PathBuf>,
}

/// 认证方式。
///
/// - `Agent`:走系统 `ssh-agent`(`SSH_AUTH_SOCK`)。桌面有 ssh-agent / 用户用
///   `ssh-add` 加好私钥时最方便,也是最安全的姿态。**移动端没有 ssh-agent,
///   不可用**。
/// - `Password`:明文密码,由前端表单填,持久化在 server 端 `~/.perga/hosts.toml`
///   (文件权限 0600)或移动端 sandbox 内。**桌面 + 移动**都能用,是平板上唯一
///   可行的 auth(除非将来接入 key 导入流程)。
#[derive(Debug, Clone)]
pub enum Auth {
    Agent,
    Password { password: String },
}
