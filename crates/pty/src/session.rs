//! `PtySession`:对外的 PTY backend 会话句柄。
//!
//! `spawn` 同步起 PTY、起子进程、起三条工作线程,返回一个对外暴露
//! `command_tx` / `event_rx`、实现 [`transport::Transport`] 的对象。
//! Drop 时**杀掉子进程**并 join 三条线程。
//!
//! 「杀掉」的契约:SIGHUP → 500ms grace → SIGKILL pgroup,**全部由 waiter
//! 线程同步执行**。理由见 [`threads::waiter_loop`]:把 `try_wait()`
//! reap 和 SIGKILL 放在同一个循环里,kernel 在 reap 之后才会复用 pid,所以
//! 「SIGKILL 到无关进程组」的窗口被锁死了。

use std::ptr;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder};
use transport::{Transport, TransportCommand, TransportEvent};

use crate::config::{to_portable_size, PtyConfig};
use crate::event::PtyError;
use crate::threads;

/// `Drop` 和 `Shutdown` 路径上 join 三条线程的总预算。
const SHUTDOWN_JOIN_BUDGET: Duration = Duration::from_secs(2);
/// SIGHUP 之后等多久再 SIGKILL pgroup。要够 shell 优雅退出(写 history、
/// flush stdout 等),又不能拖到用户感知。
pub(crate) const SIGKILL_GRACE: Duration = Duration::from_millis(500);

/// 一个活的 PTY 会话(实现 [`Transport`])。
///
/// - 调用 `command_tx().send(TransportCommand::Write(..))` 向 PTY 写入。
/// - 从 `event_rx().recv()` 拿到 Output / Exited / Error 事件。
/// - Drop 时会发 Shutdown,waiter 线程做 SIGHUP→SIGKILL 升级,然后 join 三条线程。
pub struct PtySession {
    command_tx: Sender<TransportCommand>,
    event_rx: Receiver<TransportEvent>,
    /// `Drop` 直接通知 waiter 启动 grace 计时器,绕过可能已死的 writer 线程。
    shutdown_tx: Sender<()>,
    handles: Option<ThreadHandles>,
}

struct ThreadHandles {
    reader: JoinHandle<()>,
    writer: JoinHandle<()>,
    waiter: JoinHandle<()>,
}

impl PtySession {
    /// 启动 PTY、spawn 子进程、起三条线程。
    ///
    /// 失败时**不**留下半启动状态:已 spawn 的子进程会被 [`PartialSpawn`] 兜底
    /// 杀掉并 reap,已起的工作线程会被 join。
    pub fn spawn(config: PtyConfig) -> Result<Self, PtyError> {
        let system = native_pty_system();
        let pair = system
            .openpty(to_portable_size(config.size))
            .map_err(|e| PtyError::Spawn(format!("openpty failed: {e}")))?;

        let cmd = build_command(&config);
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| PtyError::Spawn(format!("spawn {:?} failed: {e}", config.program)))?;
        // slave fd 必须在 spawn 后立刻 drop,否则 reader 永远等不到 EOF。
        drop(pair.slave);

        let master = pair.master;
        // pid / pgid 必须在 child 被 move 到 waiter 之前抓出来。pgid 走
        // master.process_group_leader() —— portable-pty 在 child 里 setsid,
        // 所以这里通常等于 child.process_id(),但用 master 报的值更明确。
        let pid = child.process_id().map(|p| p as libc::pid_t);
        let pgid = master.process_group_leader();
        let cleanup_killer = child.clone_killer();
        let writer_killer = child.clone_killer();

        let (command_tx, command_rx) = crossbeam_channel::unbounded::<TransportCommand>();
        let (event_tx, event_rx) = crossbeam_channel::unbounded::<TransportEvent>();
        let (reader_done_tx, reader_done_rx) = crossbeam_channel::bounded::<()>(1);
        // shutdown_tx 有三处持有:writer(收 TransportCommand::Shutdown 后转发)、
        // PtySession(Drop 时直接发,兜底 writer 已死)、partial(半启动失败兜底)。
        // 用 unbounded 是因为 send 调用方不能阻塞;实际只会发 1-3 次。
        let (shutdown_tx, shutdown_rx) = crossbeam_channel::unbounded::<()>();

        // 已经 spawn 了 child,从这里开始任何错误都要由 partial 兜底清理。
        let mut partial = PartialSpawn {
            cleanup_killer: Some(cleanup_killer),
            shutdown_tx_for_waiter: Some(shutdown_tx.clone()),
            pid,
            pgid,
            waiter_handle: None,
            reader_handle: None,
            writer_handle: None,
        };

        let reader = master
            .try_clone_reader()
            .map_err(|e| PtyError::Spawn(format!("clone reader failed: {e}")))?;
        let writer = master
            .take_writer()
            .map_err(|e| PtyError::Spawn(format!("take writer failed: {e}")))?;

        // 顺序:waiter 先起。只要 waiter 在跑,child 就有 wait()→reap 路径;
        // 后续任一线程 spawn 失败,partial.drop 走「signal waiter」路径,清理干净。
        partial.waiter_handle = Some(spawn_named("pty-waiter", {
            let event_tx = event_tx.clone();
            move || threads::waiter_loop(child, reader_done_rx, event_tx, shutdown_rx, pid, pgid)
        })?);

        partial.reader_handle = Some(spawn_named("pty-reader", {
            let event_tx = event_tx.clone();
            move || threads::reader_loop(reader, event_tx, reader_done_tx)
        })?);

        partial.writer_handle = Some(spawn_named("pty-writer", {
            let shutdown_tx_for_writer = shutdown_tx.clone();
            move || {
                threads::writer_loop(
                    master,
                    writer,
                    writer_killer,
                    shutdown_tx_for_writer,
                    command_rx,
                    event_tx,
                )
            }
        })?);

        tracing::info!(
            program = %config.program.display(),
            rows = config.size.rows,
            cols = config.size.cols,
            "pty.session.started"
        );

        // 成功路径:从 partial 取出 handle,partial 余下字段 None,Drop nop。
        let waiter = partial.waiter_handle.take().expect("waiter set above");
        let reader_handle = partial.reader_handle.take().expect("reader set above");
        let writer_handle = partial.writer_handle.take().expect("writer set above");
        partial.cleanup_killer.take();
        partial.shutdown_tx_for_waiter.take();

        Ok(Self {
            command_tx,
            event_rx,
            shutdown_tx,
            handles: Some(ThreadHandles {
                reader: reader_handle,
                writer: writer_handle,
                waiter,
            }),
        })
    }

    /// 命令发送端的引用。调用方可以 `.clone()` 出多个 Sender 在不同线程使用。
    pub fn command_tx(&self) -> &Sender<TransportCommand> {
        &self.command_tx
    }

    /// 事件接收端的引用。crossbeam 的 Receiver 可 clone,适合在 `select!`
    /// 里和其他 channel 一起使用。
    pub fn event_rx(&self) -> &Receiver<TransportEvent> {
        &self.event_rx
    }
}

impl Transport for PtySession {
    fn command_tx(&self) -> &Sender<TransportCommand> {
        &self.command_tx
    }

    fn event_rx(&self) -> &Receiver<TransportEvent> {
        &self.event_rx
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        // 双管齐下:走 TransportCommand 让 writer 走优雅 SIGHUP 路径;同时直接
        // 通知 waiter 启动 grace 计时器,兜底 writer 已死的情况。两个信号都是
        // 幂等的(waiter 只对第一次响应),不重复造成问题。
        let _ = self.command_tx.send(TransportCommand::Shutdown);
        let _ = self.shutdown_tx.send(());
        if let Some(handles) = self.handles.take() {
            join_handles_with_timeout(
                vec![handles.reader, handles.writer, handles.waiter],
                SHUTDOWN_JOIN_BUDGET,
            );
        }
    }
}

/// 半启动状态的清理 guard。
///
/// 字段全为 None 表示已经被「升格」成 `PtySession`,Drop nop。否则两条路径:
/// - **waiter 已起**:发一次 shutdown 信号给 waiter,由它做 grace+SIGKILL
///   并 reap。partial.drop 只 join 已起的 handle。
/// - **waiter 未起**(罕见,thread spawn 失败 = ENOMEM 级):partial 自己同步
///   走 SIGHUP→sleep→SIGKILL→waitpid 流程,把 child 收干净再退出。
struct PartialSpawn {
    cleanup_killer: Option<Box<dyn ChildKiller + Send + Sync>>,
    shutdown_tx_for_waiter: Option<Sender<()>>,
    pid: Option<libc::pid_t>,
    pgid: Option<libc::pid_t>,
    waiter_handle: Option<JoinHandle<()>>,
    reader_handle: Option<JoinHandle<()>>,
    writer_handle: Option<JoinHandle<()>>,
}

impl Drop for PartialSpawn {
    fn drop(&mut self) {
        let waiter_alive = self.waiter_handle.is_some();
        if waiter_alive {
            // 让 waiter 走它自己的 escalation 路径,**不**在这里做 escalation
            // ——否则会和 waiter 的 try_wait/reap 并发,触发用户指出的 PID 复用窗口。
            if let Some(tx) = self.shutdown_tx_for_waiter.take() {
                let _ = tx.send(());
            }
            // cleanup_killer 已无用,丢弃。
            self.cleanup_killer.take();
        } else if let Some(mut killer) = self.cleanup_killer.take() {
            // waiter 从未起来,**没人** reap child。同步走完 SIGHUP → grace
            // → SIGKILL → waitpid。整个过程 ~500ms,在罕见的 thread-spawn 失败
            // 路径上可以接受(否则 zombie 会泄漏到 init)。
            if let Err(e) = killer.kill() {
                tracing::debug!(error = %e, "pty.partial.hangup_failed");
            }
            thread::sleep(SIGKILL_GRACE);
            // SAFETY: 这是 waiter-spawn-失败路径,**没有其他线程**持有 child
            //         或在 waitpid 这个 pid。我们的 process 还是 child 的
            //         parent,kernel 不会让其他进程的 wait 抢到这个 pid。
            //         killpg/kill 在已死 pid 上返回 ESRCH,无害。
            unsafe {
                if let Some(pgid) = self.pgid {
                    libc::killpg(pgid, libc::SIGKILL);
                } else if let Some(pid) = self.pid {
                    libc::kill(pid, libc::SIGKILL);
                }
            }
            if let Some(pid) = self.pid {
                // SAFETY: 同上,我们是唯一 reaper。waitpid 阻塞,但 SIGKILL 后
                //         child 很快变 zombie 并被 reap。pathological D-state
                //         的 child 会让这里阻塞,但那是更深的 OS 问题。
                unsafe {
                    libc::waitpid(pid, ptr::null_mut(), 0);
                }
            } else {
                tracing::warn!("pty.partial.no_pid_zombie_leaked");
            }
        }

        let handles: Vec<JoinHandle<()>> = [
            self.waiter_handle.take(),
            self.reader_handle.take(),
            self.writer_handle.take(),
        ]
        .into_iter()
        .flatten()
        .collect();
        if !handles.is_empty() {
            join_handles_with_timeout(handles, SHUTDOWN_JOIN_BUDGET);
        }
    }
}

fn build_command(config: &PtyConfig) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(&config.program);
    for arg in &config.args {
        cmd.arg(arg);
    }
    if let Some(cwd) = &config.cwd {
        cmd.cwd(cwd);
    }
    // 默认终端能力,**之后** 被 config.env 覆盖,这样调用方仍然可以显式
    // 指定 TERM。当前终端引擎按 xterm-256color 能力集推进,后续若要更精细
    // 声明再单独核对。
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    for k in &config.env_remove {
        cmd.env_remove(k);
    }
    for (k, v) in &config.env {
        cmd.env(k, v);
    }
    cmd
}

fn spawn_named<F>(name: &'static str, f: F) -> Result<JoinHandle<()>, PtyError>
where
    F: FnOnce() + Send + 'static,
{
    thread::Builder::new()
        .name(name.into())
        .spawn(f)
        .map_err(|e| PtyError::Spawn(format!("spawn thread {name}: {e}")))
}

/// 并发 join 任意数量的线程,整体 deadline 由调用方给。
///
/// 超时的处理:**detach**(放任 join 线程继续等),只记 warn。Drop 不 panic,
/// 符合 CLAUDE.md 错误处理「让程序在正确的位置以正确的方式失败」。
fn join_handles_with_timeout(handles: Vec<JoinHandle<()>>, timeout: Duration) {
    let total = handles.len();
    if total == 0 {
        return;
    }
    let (done_tx, done_rx) = crossbeam_channel::bounded::<usize>(total);

    for (idx, handle) in handles.into_iter().enumerate() {
        let tx = done_tx.clone();
        let _ = thread::Builder::new()
            .name(format!("pty-join-{idx}"))
            .spawn(move || {
                if let Err(panic) = handle.join() {
                    tracing::warn!(idx, ?panic, "pty.session.thread_panicked");
                }
                let _ = tx.send(idx);
            });
    }
    drop(done_tx);

    let deadline = Instant::now() + timeout;
    let mut received = 0usize;
    while received < total {
        let Some(left) = deadline.checked_duration_since(Instant::now()) else {
            tracing::warn!(
                remaining = total - received,
                "pty.session.join_timeout_detaching"
            );
            return;
        };
        match done_rx.recv_timeout(left) {
            Ok(_) => received += 1,
            Err(_) => {
                tracing::warn!(
                    remaining = total - received,
                    "pty.session.join_timeout_detaching"
                );
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use transport::TerminalSize;

    use super::*;
    use crate::PtyConfig;

    #[test]
    fn build_command_removes_requested_env_after_terminal_defaults() {
        let mut cfg = PtyConfig::new(PathBuf::from("/bin/sh"), TerminalSize::new(24, 80));
        cfg.env_remove.push("COLORTERM".to_string());

        let cmd = build_command(&cfg);

        assert_eq!(
            cmd.get_env("TERM").and_then(|v| v.to_str()),
            Some("xterm-256color")
        );
        assert!(cmd.get_env("COLORTERM").is_none());
    }

    #[test]
    fn build_command_env_override_wins_after_remove() {
        let mut cfg = PtyConfig::new(PathBuf::from("/bin/sh"), TerminalSize::new(24, 80));
        cfg.env_remove.push("TERM".to_string());
        cfg.env
            .push(("TERM".to_string(), "screen-256color".to_string()));

        let cmd = build_command(&cfg);

        assert_eq!(
            cmd.get_env("TERM").and_then(|v| v.to_str()),
            Some("screen-256color")
        );
    }
}
