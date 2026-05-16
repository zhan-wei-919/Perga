//! `perga` 演示二进制:把宿主 stdin/stdout 接到 `pty` crate 提供的 PTY
//! 通路上,验证「字节进 / 字节出 + 退出与 resize 通路」整体可工作。
//!
//! 这一层**不解析**任何终端协议 —— 宿主终端自己会把 PTY 输出渲染出来,
//! 这正好就是「PTY 层不转译」设计意图的现场演示。

mod raw_mode;

use std::io::{self, Write};
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, OwnedFd, RawFd};
use std::thread;

use crossbeam_channel::{Receiver, Sender};
use nix::poll::{PollFd, PollFlags, PollTimeout};
use nix::unistd;
use pty::{PtyCommand, PtyConfig, PtyEvent, PtySession, PtySize};
use signal_hook::consts::SIGWINCH;
use signal_hook::iterator::Signals;
use tracing_subscriber::EnvFilter;

use crate::raw_mode::RawModeGuard;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    init_tracing();

    let stdout_fd = io::stdout().as_raw_fd();
    let size = term_size_from_fd(stdout_fd).unwrap_or(PtySize::new(24, 80));

    // Raw mode 先于 spawn 子进程:stdin 不是 tty 时直接 fail-fast,
    // 而不是先把 shell 拉起来再回头清理。RAII guard 自身 Drop 会还原 termios。
    let _raw = RawModeGuard::enter(io::stdin().as_raw_fd())?;

    let mut cfg = PtyConfig::with_default_shell(size);
    cfg.cwd = std::env::current_dir().ok();
    // banner 用到 program 字段,需要在 cfg 被 move 进 spawn 之前打。
    print_banner(&cfg, size);
    let session = PtySession::spawn(cfg)?;

    // self-pipe:output 线程在看到 Exited/Error 后 drop wake_tx,关闭
    // 写端;主循环 poll(wake_rx) 看到 POLLHUP 立刻醒过来,不需要用户
    // 多按一个键来解锁阻塞的 stdin.read。
    let (wake_rx, wake_tx) = unistd::pipe()?;

    let event_rx = session.event_rx().clone();
    let output_thread = thread::Builder::new()
        .name("perga-output".into())
        .spawn(move || forward_output(event_rx, wake_tx))?;

    let command_tx_sigwinch = session.command_tx().clone();
    let mut signals = Signals::new([SIGWINCH])?;
    thread::Builder::new()
        .name("perga-sigwinch".into())
        .spawn(move || {
            for _sig in &mut signals {
                if let Some(new_size) = term_size_from_fd(stdout_fd) {
                    if command_tx_sigwinch
                        .send(PtyCommand::Resize(new_size))
                        .is_err()
                    {
                        break;
                    }
                }
            }
        })?;

    pump_stdin(session.command_tx().clone(), wake_rx)?;

    // drop(session) 会触发 Shutdown + 等待三条工作线程退出。
    drop(session);
    let _ = output_thread.join();
    // Raw mode 退出前,显式 \r\n 把光标拉到下一行行首,避免下条 host
    // shell 提示和 PTY 残留输出黏在一起。
    let _ = io::stderr().write_all(b"\r\n[perga] bye.\r\n");
    Ok(())
}

/// stdin 阻塞 read + wake_rx 的非阻塞解锁,二选一。
///
/// 直接 `unistd::read` 走 raw fd,绕过 `std::io::Stdin` 的内部缓冲,
/// 否则缓冲层可能截留单字节(raw mode 下用户体验会变差)。
fn pump_stdin(command_tx: Sender<PtyCommand>, wake_rx: OwnedFd) -> io::Result<()> {
    let stdin_fd = io::stdin().as_raw_fd();
    // SAFETY: stdin (fd 0) 在整个进程生命周期都有效。
    let stdin_borrowed = unsafe { BorrowedFd::borrow_raw(stdin_fd) };
    let mut buf = [0u8; 4096];

    loop {
        let mut fds = [
            PollFd::new(stdin_borrowed, PollFlags::POLLIN),
            PollFd::new(wake_rx.as_fd(), PollFlags::POLLIN),
        ];
        match nix::poll::poll(&mut fds, PollTimeout::NONE) {
            Ok(_) => {}
            // SIGWINCH 等信号打断 poll;重新进入即可。
            Err(nix::errno::Errno::EINTR) => continue,
            Err(e) => return Err(io::Error::from(e)),
        }

        let wake_evts = fds[1].revents().unwrap_or(PollFlags::empty());
        if wake_evts.intersects(PollFlags::POLLIN | PollFlags::POLLHUP) {
            return Ok(());
        }

        let stdin_evts = fds[0].revents().unwrap_or(PollFlags::empty());
        if stdin_evts.contains(PollFlags::POLLIN) {
            match unistd::read(stdin_fd, &mut buf) {
                Ok(0) => return Ok(()),
                Ok(n) => {
                    if command_tx
                        .send(PtyCommand::Write(buf[..n].to_vec()))
                        .is_err()
                    {
                        return Ok(());
                    }
                }
                Err(nix::errno::Errno::EINTR) => continue,
                Err(e) => return Err(io::Error::from(e)),
            }
        }
        if stdin_evts.intersects(PollFlags::POLLHUP | PollFlags::POLLERR) {
            return Ok(());
        }
    }
}

fn forward_output(rx: Receiver<PtyEvent>, wake_tx: OwnedFd) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    while let Ok(ev) = rx.recv() {
        match ev {
            PtyEvent::Output(data) => {
                if out.write_all(&data).is_err() {
                    break;
                }
                let _ = out.flush();
            }
            PtyEvent::Exited(status) => {
                tracing::info!(
                    code = status.code,
                    success = status.success,
                    "perga.pty.exited"
                );
                break;
            }
            PtyEvent::Error(err) => {
                tracing::warn!(error = %err, "perga.pty.error");
                break;
            }
        }
    }
    // 函数返回时 wake_tx drop,pipe 写端关闭 → 主循环 poll 收到 POLLHUP。
    drop(wake_tx);
}

/// 启动横幅,纯视觉提示:让用户知道接下来的 shell 是 perga PTY 里的 shell,
/// 而不是宿主 shell。两者看起来一模一样(同一个 bash + 同一份 PS1)。
///
/// 输出走 stderr,**避免**和 PTY 子进程的 stdout 流抢宿主 stdout 排版。
/// 显式 `\r\n` 是因为 raw mode 下 OPOST 关闭,单纯 `\n` 不会回到行首。
fn print_banner(cfg: &PtyConfig, size: PtySize) {
    let _ = write!(
        io::stderr(),
        "\r\n[perga] PTY demo: {} @ {}x{}. exit / Ctrl-D 退出.\r\n\r\n",
        cfg.program.display(),
        size.rows,
        size.cols,
    );
}

/// 通过 TIOCGWINSZ 读出当前真实终端尺寸。stdout 不是 tty(被管道接管)时
/// 返回 None,调用方走默认 24x80。
fn term_size_from_fd(fd: RawFd) -> Option<PtySize> {
    // SAFETY: winsize 是 POD,zero-init 是合法的初始状态。
    let mut ws: nix::libc::winsize = unsafe { std::mem::zeroed() };
    // SAFETY: fd 是调用方传入的有效 fd;buffer 由我们拥有,大小匹配 ioctl 协议。
    let rc = unsafe {
        nix::libc::ioctl(
            fd,
            nix::libc::TIOCGWINSZ,
            &mut ws as *mut nix::libc::winsize,
        )
    };
    if rc != 0 || ws.ws_row == 0 || ws.ws_col == 0 {
        return None;
    }
    Some(PtySize::new(ws.ws_row, ws.ws_col))
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn"));
    tracing_subscriber::fmt()
        .with_writer(io::stderr)
        .with_env_filter(filter)
        .init();
}
