//! PTY 启动参数与默认 shell 选择。
//!
//! 这里是「边界验证」的现场:对外提供 `default_shell()`,把 `$SHELL` 的
//! 形式校验放在入口处一次完成,下游线程信任 `PtyConfig::program` 已经
//! 是一条预期的可执行路径。

use std::path::PathBuf;

/// 终端尺寸,单位 cells。pixel 维度暂不支持。
///
/// 第一刀只关心 rows/cols;sixel / iTerm image 等需要像素的协议
/// 在终端引擎层接入时再扩展。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PtySize {
    pub rows: u16,
    pub cols: u16,
}

impl PtySize {
    pub const fn new(rows: u16, cols: u16) -> Self {
        Self { rows, cols }
    }
}

impl From<PtySize> for portable_pty::PtySize {
    fn from(s: PtySize) -> Self {
        Self {
            rows: s.rows,
            cols: s.cols,
            pixel_width: 0,
            pixel_height: 0,
        }
    }
}

/// 创建一个 PTY 子进程所需要的完整描述。
///
/// 调用方决定执行什么、在哪里执行、环境是什么。`env` 是「追加 / 覆盖」语义,
/// 由 `portable-pty` 的 `CommandBuilder` 应用到继承的环境上。
#[derive(Debug, Clone)]
pub struct PtyConfig {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(String, String)>,
    pub size: PtySize,
}

impl PtyConfig {
    pub fn new(program: PathBuf, size: PtySize) -> Self {
        Self {
            program,
            args: Vec::new(),
            cwd: None,
            env: Vec::new(),
            size,
        }
    }

    /// 用 `default_shell()` 填充 program。
    pub fn with_default_shell(size: PtySize) -> Self {
        Self::new(default_shell(), size)
    }
}

/// 读取 `$SHELL` 环境变量;未设置或不是绝对路径时回退 `/bin/bash`。
///
/// 这里只做「形式上」的校验。可执行性 / 是否存在交给 `spawn_command` 自己
/// 报错,**不**在这里偷偷帮调用方试探各种候选 shell —— 那是兜底,会把
/// 「$SHELL 配错了」这种真实 bug 抹平。
pub fn default_shell() -> PathBuf {
    if let Some(raw) = std::env::var_os("SHELL") {
        let candidate = PathBuf::from(&raw);
        if candidate.is_absolute() {
            return candidate;
        }
    }
    PathBuf::from("/bin/bash")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `default_shell` 直接读 process 全局环境,测试用顺序锁串行化以避免
    /// 跨线程并发改 env 导致的 flake。
    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        use std::sync::{Mutex, OnceLock};
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    struct ShellGuard {
        original: Option<std::ffi::OsString>,
    }

    impl ShellGuard {
        fn set(value: Option<&str>) -> Self {
            let original = std::env::var_os("SHELL");
            // SAFETY: 测试串行化通过 env_lock(),保证当前进程内只有这一处
            //        改 SHELL,避免 std::env::set_var 的多线程 UB。
            unsafe {
                match value {
                    Some(v) => std::env::set_var("SHELL", v),
                    None => std::env::remove_var("SHELL"),
                }
            }
            Self { original }
        }
    }

    impl Drop for ShellGuard {
        fn drop(&mut self) {
            // SAFETY: 同上,串行化保证。
            unsafe {
                match self.original.take() {
                    Some(v) => std::env::set_var("SHELL", v),
                    None => std::env::remove_var("SHELL"),
                }
            }
        }
    }

    #[test]
    fn default_shell_uses_absolute_env() {
        let _lock = env_lock();
        let _guard = ShellGuard::set(Some("/usr/local/bin/fish"));
        assert_eq!(default_shell(), PathBuf::from("/usr/local/bin/fish"));
    }

    #[test]
    fn default_shell_falls_back_on_relative_env() {
        let _lock = env_lock();
        let _guard = ShellGuard::set(Some("fish"));
        assert_eq!(default_shell(), PathBuf::from("/bin/bash"));
    }

    #[test]
    fn default_shell_falls_back_when_unset() {
        let _lock = env_lock();
        let _guard = ShellGuard::set(None);
        assert_eq!(default_shell(), PathBuf::from("/bin/bash"));
    }
}
