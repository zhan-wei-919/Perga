//! `TerminalSession` 同步开局工厂。
//!
//! 两条入口:
//! - [`open_local`]:本地 PTY,fork+exec 默认 shell,注入 shell 集成。caller
//!   传 cwd(server 一般传 `current_dir()`,原生客户端可按平台策略决定)。
//!   **仅桌面 target 可用** —— `pty` crate 在 mobile target 编译为空。
//! - [`open_ssh`]:走 `crates/ssh` 建 SSH 会话,known_hosts 路径由 caller 决定。
//!   桌面 / 移动通用,SSH 是 mobile 的主路径。
//!
//! 两条入口都是**同步阻塞**,内部完成 connect / fork。caller 通常用
//! `spawn_blocking`(server 走 tokio,原生客户端可走专用线程)把它隔离到独立线程。

use std::path::PathBuf;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use pty::{inject_shell_integration, PtyConfig};
use ssh::SshSession;
use terminal_session::TerminalSession;
use transport::TerminalSize;

use crate::profiles::{to_ssh_config, HostProfile};

/// 开本地 shell session。
///
/// `cwd`:子进程工作目录。`None` 让 portable-pty 走默认(继承父进程)。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn open_local(size: TerminalSize, cwd: Option<PathBuf>) -> Result<TerminalSession, OpenError> {
    let mut cfg = PtyConfig::with_default_shell(size);
    cfg.cwd = cwd;
    sanitize_local_shell_env(&mut cfg);
    inject_shell_integration(&mut cfg);
    TerminalSession::spawn_local(cfg).map_err(|e| OpenError::LocalPty(format!("{e}")))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn sanitize_local_shell_env(cfg: &mut PtyConfig) {
    // pnpm/npm set this while running scripts. If Perga is launched from that
    // environment, nvm refuses to load and user-global node commands disappear
    // from the local shell.
    cfg.env_remove.push("npm_config_prefix".to_string());
    cfg.env_remove.push("NPM_CONFIG_PREFIX".to_string());

    // macOS GUI apps often start without LANG/LC_CTYPE. zsh then treats UTF-8
    // input as invalid bytes and echoes each byte as U+FFFD, which shows up as
    // "������" after committing Chinese IME text.
    if std::env::var_os("LC_ALL").is_none()
        && std::env::var_os("LC_CTYPE").is_none()
        && std::env::var_os("LANG").is_none()
    {
        cfg.env.push(("LC_CTYPE".to_string(), "UTF-8".to_string()));
    }
}

/// 开 SSH session(connect + auth + open shell)。
///
/// `known_hosts_path`:`None` 让 ssh crate 走 `~/.ssh/known_hosts`(桌面默认);
/// `Some(path)` 用 caller 指定路径(例如平台 app data 目录)。
pub fn open_ssh(
    profile: &HostProfile,
    size: TerminalSize,
    known_hosts_path: Option<PathBuf>,
) -> Result<TerminalSession, OpenError> {
    let ssh_cfg = to_ssh_config(profile, known_hosts_path);
    let ssh = SshSession::spawn(ssh_cfg, size)?;
    // spawn_with_transport 只剩 thread spawn 失败这一种;把它折成 Wrap 便于
    // 上层统一处理。
    TerminalSession::spawn_with_transport(Box::new(ssh), size)
        .map_err(|e| OpenError::Wrap(format!("{e}")))
}

#[cfg(all(test, not(any(target_os = "android", target_os = "ios"))))]
mod tests {
    use super::*;

    #[test]
    fn local_shell_env_removes_npm_prefix_vars() {
        let mut cfg = PtyConfig::with_default_shell(TerminalSize::new(24, 80));

        sanitize_local_shell_env(&mut cfg);

        assert!(cfg.env_remove.iter().any(|k| k == "npm_config_prefix"));
        assert!(cfg.env_remove.iter().any(|k| k == "NPM_CONFIG_PREFIX"));
    }

    #[test]
    fn local_shell_env_sets_utf8_ctype_when_locale_missing() {
        let _lock = env_lock();
        let _guard = LocaleGuard::clear();
        let mut cfg = PtyConfig::with_default_shell(TerminalSize::new(24, 80));

        sanitize_local_shell_env(&mut cfg);

        assert!(cfg.env.iter().any(|(k, v)| k == "LC_CTYPE" && v == "UTF-8"));
    }

    #[test]
    fn local_shell_env_keeps_existing_locale() {
        let _lock = env_lock();
        let _guard = LocaleGuard::set_lang("zh_CN.UTF-8");
        let mut cfg = PtyConfig::with_default_shell(TerminalSize::new(24, 80));

        sanitize_local_shell_env(&mut cfg);

        assert!(!cfg.env.iter().any(|(k, _)| k == "LC_CTYPE"));
    }

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        use std::sync::{Mutex, OnceLock};
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    struct LocaleGuard {
        lc_all: Option<std::ffi::OsString>,
        lc_ctype: Option<std::ffi::OsString>,
        lang: Option<std::ffi::OsString>,
    }

    impl LocaleGuard {
        fn clear() -> Self {
            let guard = Self::snapshot();
            // SAFETY: tests serialize process env mutation through env_lock().
            unsafe {
                std::env::remove_var("LC_ALL");
                std::env::remove_var("LC_CTYPE");
                std::env::remove_var("LANG");
            }
            guard
        }

        fn set_lang(value: &str) -> Self {
            let guard = Self::clear();
            // SAFETY: tests serialize process env mutation through env_lock().
            unsafe {
                std::env::set_var("LANG", value);
            }
            guard
        }

        fn snapshot() -> Self {
            Self {
                lc_all: std::env::var_os("LC_ALL"),
                lc_ctype: std::env::var_os("LC_CTYPE"),
                lang: std::env::var_os("LANG"),
            }
        }
    }

    impl Drop for LocaleGuard {
        fn drop(&mut self) {
            // SAFETY: tests serialize process env mutation through env_lock().
            restore_env("LC_ALL", self.lc_all.take());
            restore_env("LC_CTYPE", self.lc_ctype.take());
            restore_env("LANG", self.lang.take());
        }
    }

    fn restore_env(key: &str, value: Option<std::ffi::OsString>) {
        // SAFETY: tests serialize process env mutation through env_lock().
        unsafe {
            match value {
                Some(v) => std::env::set_var(key, v),
                None => std::env::remove_var(key),
            }
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum OpenError {
    /// 本地 PTY 错误。仅桌面 target 可达 —— mobile 上 `open_local` 整体不存在。
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[error("local pty: {0}")]
    LocalPty(String),
    #[error("ssh: {0}")]
    Ssh(#[from] ssh::SshError),
    #[error("wrap into terminal-session: {0}")]
    Wrap(String),
}
