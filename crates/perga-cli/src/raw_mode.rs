//! 把宿主终端 stdin 设为 raw mode 的 RAII guard。
//!
//! Demo binary 把宿主 stdin 当作「上层输入」原样转发给 PTY。这要求:
//! - 关闭 ICANON,这样每个按键都立刻返回,而不是等回车。
//! - 关闭 ECHO,PTY 里的 shell 自己会做 echo。
//! - 关闭 ISIG,Ctrl+C / Ctrl+Z 等转给 shell,而不是被宿主 termios 拦截。
//!
//! `cfmakeraw` 一次性满足上述。Drop 时还原宿主 termios,**包括** demo 异常
//! panic 退出时的还原:Rust 默认 unwind 会展开栈,RAII Drop 会执行。

use std::io;
use std::os::fd::{BorrowedFd, RawFd};

use nix::sys::termios::{self, SetArg, Termios};

pub struct RawModeGuard {
    fd: RawFd,
    original: Termios,
}

impl RawModeGuard {
    pub fn enter(fd: RawFd) -> io::Result<Self> {
        let borrowed = borrow(fd);
        let original = termios::tcgetattr(borrowed).map_err(io::Error::from)?;
        let mut raw = original.clone();
        termios::cfmakeraw(&mut raw);
        termios::tcsetattr(borrowed, SetArg::TCSANOW, &raw).map_err(io::Error::from)?;
        Ok(Self { fd, original })
    }
}

impl Drop for RawModeGuard {
    fn drop(&mut self) {
        let borrowed = borrow(self.fd);
        // 尽力还原;若失败,宿主 shell 会停留在 raw mode,但这种情况
        // 极罕见(基本就是 fd 已经关闭),没有合适的恢复手段。
        if let Err(e) = termios::tcsetattr(borrowed, SetArg::TCSANOW, &self.original) {
            tracing::warn!(error = %e, fd = self.fd, "raw_mode.restore_failed");
        }
    }
}

fn borrow(fd: RawFd) -> BorrowedFd<'static> {
    // SAFETY: 调用方传入的总是 stdin / stdout / stderr 之一,这三个 fd
    //         在整个进程生命周期都保持有效;BorrowedFd<'static> 在这里
    //         不会指向悬空 fd。
    unsafe { BorrowedFd::borrow_raw(fd) }
}
