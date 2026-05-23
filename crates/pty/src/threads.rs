//! reader / writer / waiter 三条同步线程的循环体。
//!
//! 不引入 tokio:PTY 在 Unix 上是阻塞 fd,`portable-pty` 与
//! `alacritty_terminal` 都是同步的,「每个 PTY 一组线程」是 alacritty /
//! wezterm 都在用的模型。
//!
//! 线程归属:
//! - **reader**:持 `Box<dyn Read + Send>`,阻塞 read → 发 Output。
//! - **writer**:持 `MasterPty` + `Box<dyn Write + Send>` + 一个 SIGHUP killer
//!   + `shutdown_tx`,收命令做 write / resize / SIGHUP+signal waiter。
//! - **waiter**:持 `Box<dyn Child>` + `shutdown_rx` + raw pid/pgid。轮询
//!   `try_wait`,看到 shutdown 信号就启动 grace 计时器,grace 用尽后**在同
//!   一线程内**调 SIGKILL —— 这避免了「另一线程已 reap,pid 被复用,
//!   SIGKILL 杀到无关进程」的窗口。

use std::io::{self, Read, Write};
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender, TryRecvError};
use transport::{TransportCommand, TransportError, TransportEvent};

use crate::config::to_portable_size;
use crate::event::{exit_status_from_portable, PtyError};
use crate::session::SIGKILL_GRACE;

/// waiter 的 try_wait 轮询间隔。对终端用户而言 50ms 不可感知;
/// 期间 child 的 zombie 状态一直占着 pid,SIGKILL 也只在同一循环里发,
/// 不存在 reap / 复用的竞争窗口。
const WAITER_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// 读 PTY master 字节,封成 `TransportEvent::Output` 发到事件总线。
///
/// 关闭路径上 Linux 通常返回 `EIO`,macOS 通常 `Ok(0)`;两种都是「子进程
/// 退出后 master 端被 hang up」的正常信号,**不**当作错误上报 ——
/// 真正的退出由 waiter 的 `Exited` 表达,这里再重复一份只是噪声。
///
/// 不管走哪条退出路径,`done_tx` 都会在函数返回时被 drop,从而通知 waiter
/// reader 已经排完缓冲区。这是「Exited 是最后事件」的关键。
pub(crate) fn reader_loop(
    mut reader: Box<dyn Read + Send>,
    event_tx: Sender<TransportEvent>,
    done_tx: Sender<()>,
) {
    let mut buf = vec![0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if event_tx
                    .send(TransportEvent::Output(buf[..n].to_vec()))
                    .is_err()
                {
                    // consumer 已经断开;不存在「向虚空写日志」的必要。
                    break;
                }
            }
            Err(e) if is_closed_pty_error(&e) => break,
            Err(e) => {
                tracing::warn!(error = %e, "pty.reader.io_error");
                let _ = event_tx.send(TransportEvent::Error(TransportError::Read(format!(
                    "{}",
                    PtyError::Read(e)
                ))));
                break;
            }
        }
    }
    let _ = done_tx.send(());
}

/// 收 `TransportCommand`,把字节写进 master / 调 resize / 触发 shutdown。
///
/// 错误分类:
/// - `Write` 失败 = 写入通路断了,继续收 Write 没意义 → 发 `TransportEvent::Error` 后退出。
/// - `Resize` 失败 = 窗口竞争 / 内核临时拒绝,**不致命** → 只 warn,**不**发 event。
/// - `Shutdown` = 调用方主动要求关闭:同步发 SIGHUP(给 shell 写 history 的机会),
///   然后通过 `shutdown_tx` 通知 waiter 启动 grace 计时器。**不**在 writer 里
///   做 SIGKILL escalation —— escalation 必须和 reap 在同一个线程,见
///   [`waiter_loop`] 注释。
pub(crate) fn writer_loop(
    master: Box<dyn portable_pty::MasterPty + Send>,
    mut writer: Box<dyn Write + Send>,
    mut hangup_killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
    shutdown_tx: Sender<()>,
    cmd_rx: Receiver<TransportCommand>,
    event_tx: Sender<TransportEvent>,
) {
    while let Ok(cmd) = cmd_rx.recv() {
        match cmd {
            TransportCommand::Write(data) => {
                if let Err(e) = writer.write_all(&data) {
                    tracing::warn!(error = %e, "pty.writer.write_failed");
                    let _ = event_tx.send(TransportEvent::Error(TransportError::Write(format!(
                        "{}",
                        PtyError::Write(e)
                    ))));
                    break;
                }
            }
            TransportCommand::Resize(size) => {
                if let Err(e) = master.resize(to_portable_size(size)) {
                    tracing::warn!(error = %e, "pty.writer.resize_failed");
                    // 不发 event:resize 失败非致命,后续 resize 可重试,
                    // write 通路应保持可用。
                }
            }
            TransportCommand::Shutdown => {
                if let Err(e) = hangup_killer.kill() {
                    // 子进程可能已经自己退了,kill 报 ESRCH 是正常事件。
                    tracing::debug!(error = %e, "pty.writer.hangup_after_shutdown");
                }
                let _ = shutdown_tx.send(());
                break;
            }
        }
    }
    // 显式 drop:关掉 master 与 writer fd,触发 reader 的 EOF 路径。
    drop(writer);
    drop(master);
}

/// 监管 child 生命周期。**同一线程内**做三件事的好处:
/// 1. 轮询 `try_wait()`:non-blocking reap。返回 `Some(status)` 后 child 进入
///    OS 视角的「已 reap」状态,**只有此后**才轮到 kernel 复用 pid。
/// 2. 看 `shutdown_rx`:外部要求关闭就启动 grace 计时器。
/// 3. grace 用完且 child 还没 reap 时,**就地**调 `libc::killpg(pgid, SIGKILL)`
///    或 `libc::kill(pid, SIGKILL)`。**关键不变量**:SIGKILL 只在「这一轮
///    `try_wait` 刚返回 `None`」时发,意味着 pid 仍被 zombie/live child 占用,
///    kernel 不可能把它复用到别的进程。
///
/// reader-done barrier:循环退出后等 `reader_done` 确认 reader 已排完
/// master 缓冲区,**再**发 `Exited`,这是「Exited 是最后事件」的另一半。
pub(crate) fn waiter_loop(
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    reader_done: Receiver<()>,
    event_tx: Sender<TransportEvent>,
    shutdown_rx: Receiver<()>,
    pid: Option<libc::pid_t>,
    pgid: Option<libc::pid_t>,
) {
    let mut shutdown_seen_at: Option<Instant> = None;
    let mut escalated = false;

    let wait_result: io::Result<portable_pty::ExitStatus> = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => {}
            Err(e) => break Err(e),
        }

        // 抓 shutdown 信号(只抓第一次)。
        if shutdown_seen_at.is_none() {
            match shutdown_rx.try_recv() {
                Ok(()) => shutdown_seen_at = Some(Instant::now()),
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => {
                    // 所有 sender 都没了。如果是 PtySession 正常 drop,我们
                    // 之前应当已经收到 Ok(())。能走到这里说明 PtySession 在
                    // 没发 shutdown 的情况下消失(panic+forget?);此时
                    // shutdown_seen_at 仍为 None,按「等 child 自己退」处理。
                }
            }
        }

        // grace 用完就 SIGKILL pgroup。**就地发,不 detach**——这一行执行时
        // try_wait 刚返回 None,pid/pgid 仍属于我们的 child,不会误伤。
        if let Some(t) = shutdown_seen_at {
            if !escalated && t.elapsed() >= SIGKILL_GRACE {
                escalated = true;
                tracing::debug!(?pid, ?pgid, "pty.waiter.escalating_to_sigkill");
                // SAFETY: try_wait 在本轮迭代刚返回 None,child 还没被 reap,
                //         kernel 不会把这个 pid/pgid 复用到别的进程。kill /
                //         killpg 对已死(zombie)进程返回 ESRCH,无害。
                unsafe {
                    if let Some(pgid) = pgid {
                        libc::killpg(pgid, libc::SIGKILL);
                    } else if let Some(pid) = pid {
                        libc::kill(pid, libc::SIGKILL);
                    }
                }
            }
        }

        std::thread::sleep(WAITER_POLL_INTERVAL);
    };

    // child 已退;让 reader 把 master 缓冲区里的尾部字节也排干净,**再**发 Exited。
    let _ = reader_done.recv();

    let event = match wait_result {
        Ok(status) => TransportEvent::Exited(exit_status_from_portable(status)),
        Err(e) => {
            tracing::warn!(error = %e, "pty.waiter.wait_failed");
            TransportEvent::Error(TransportError::Wait(format!(
                "{}",
                PtyError::Wait(e.to_string())
            )))
        }
    };
    let _ = event_tx.send(event);
}

/// EIO(5) / EBADF(9) / UnexpectedEof 都是「master 已被关闭」的正常表达。
///
/// 数值用裸常量,**不**为这两个数引入 `libc` 直接依赖 —— POSIX 已经把这两
/// 个 errno 锁定在固定整数,可移植性靠的是 POSIX,不是 crate 版本。
fn is_closed_pty_error(e: &io::Error) -> bool {
    matches!(e.raw_os_error(), Some(5) | Some(9)) || e.kind() == io::ErrorKind::UnexpectedEof
}
