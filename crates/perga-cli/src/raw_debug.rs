//! PTY → protocol JSON 调试模式。
//!
//! 这里故意不进 raw mode,也不接前端:宿主 stdin 以行模式进 PTY,
//! `PtyEvent::Output` 经 `terminal-engine` 和 `terminal-protocol` 变成
//! pretty JSON。这样能单独看后端会发给前端的协议消息。

use std::io::{self, Write};
use std::os::fd::{AsRawFd, BorrowedFd};
use std::time::{Duration, Instant};

use crossbeam_channel::Sender;
use nix::poll::{PollFd, PollFlags, PollTimeout};
use nix::unistd;
use pty::{inject_shell_integration, PtyCommand, PtyConfig, PtyEvent, PtySession, PtySize};
use terminal_engine::{TerminalEngine, TerminalSize};
use terminal_protocol::{ExitStatus as ProtocolExitStatus, ProtocolEncoder};

const EVENT_TICK: Duration = Duration::from_millis(20);
/// host stdin EOF 后补发 Ctrl-D 的间隔。
///
/// 只发一次会和 shell 启动抢跑:0x04 在 shell 切到 readline raw mode 之前,
/// 被 canonical 行规当成 VEOF、组成空行 EOF 后丢掉。所以周期补发,直到某
/// 一发 Ctrl-D 落在 shell 的空 prompt 上、shell 自己干净退出。
///
/// **不设输出 idle 超时**:shell 跑一条静默长命令(`sleep 30`)时同样长时间
/// 无输出,靠「无输出」判定卡死会误杀合法命令。shell 真卡死(用户 pipe 了
/// 死循环)就让它挂着、由用户 Ctrl-C —— 这是 debug 工具该有的诚实行为。
const EOF_CTRL_D_RESEND: Duration = Duration::from_millis(200);

/// 启动一个最小 protocol JSON debug session。
pub(crate) fn run(size: PtySize) -> Result<(), Box<dyn std::error::Error>> {
    let mut cfg = PtyConfig::with_default_shell(size);
    cfg.cwd = std::env::current_dir().ok();
    inject_shell_integration(&mut cfg);

    eprintln!(
        "[perga raw-debug] shell: {} @ {}x{}",
        cfg.program.display(),
        size.rows,
        size.cols
    );
    eprintln!(
        "[perga raw-debug] type commands normally; Ctrl-D shuts down. Output is pretty JSON."
    );

    let session = PtySession::spawn(cfg)?;
    let mut engine = TerminalEngine::new(TerminalSize::new(size.rows, size.cols));
    let mut encoder = ProtocolEncoder::new();
    print_json_event(encoder.encode_frame(
        engine.snapshot(),
        engine.modes(),
        engine.title(),
        engine.active_top(),
    ))?;

    let stdin_fd = io::stdin().as_raw_fd();
    // SAFETY: stdin (fd 0) is valid for the process lifetime.
    let stdin_borrowed = unsafe { BorrowedFd::borrow_raw(stdin_fd) };
    let mut stdin_open = true;
    // host stdin EOF 后上一次补发 Ctrl-D 的时刻;None = stdin 仍开 / 还没发过。
    let mut last_ctrl_d: Option<Instant> = None;
    let mut buf = [0u8; 4096];

    loop {
        let mut done = false;
        match session.event_rx().recv_timeout(EVENT_TICK) {
            Ok(event) => {
                done = handle_event(event, &mut engine, &mut encoder, session.command_tx())?;
            }
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => done = true,
        }

        while !done {
            match session.event_rx().try_recv() {
                Ok(event) => {
                    done = handle_event(event, &mut engine, &mut encoder, session.command_tx())?;
                }
                Err(crossbeam_channel::TryRecvError::Empty) => break,
                Err(crossbeam_channel::TryRecvError::Disconnected) => {
                    done = true;
                    break;
                }
            }
        }

        if done {
            break;
        }

        if stdin_open && stdin_ready(stdin_borrowed)? {
            match unistd::read(stdin_fd, &mut buf) {
                Ok(0) => {
                    // Host EOF:不强制 Shutdown,改用下方周期 Ctrl-D 驱动 shell
                    // 自己干净退出。
                    stdin_open = false;
                }
                Ok(n) => {
                    if session
                        .command_tx()
                        .send(PtyCommand::Write(buf[..n].to_vec()))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(nix::errno::Errno::EINTR) => {}
                Err(e) => return Err(Box::new(io::Error::from(e))),
            }
        }

        // host stdin 已 EOF:周期性补发 Ctrl-D,直到某一发落在 shell 的空
        // prompt 上、shell 自己退出(见 EOF_CTRL_D_RESEND)。
        if !stdin_open {
            let due = match last_ctrl_d {
                None => true,
                Some(at) => at.elapsed() >= EOF_CTRL_D_RESEND,
            };
            if due {
                last_ctrl_d = Some(Instant::now());
                if session
                    .command_tx()
                    .send(PtyCommand::Write(vec![0x04]))
                    .is_err()
                {
                    break;
                }
            }
        }
    }

    drop(session);
    Ok(())
}

fn handle_event(
    event: PtyEvent,
    engine: &mut TerminalEngine,
    encoder: &mut ProtocolEncoder,
    command_tx: &Sender<PtyCommand>,
) -> io::Result<bool> {
    match event {
        PtyEvent::Output(data) => {
            engine.feed(&data);
            for pending in engine.drain_pending_writes() {
                if command_tx.send(PtyCommand::Write(pending)).is_err() {
                    return Ok(true);
                }
            }
            // 与 terminal-session 的事件循环一致:命令块在 frame 之前 emit。
            for cmd in engine.drain_marks() {
                print_json_event(encoder.encode_command_block(
                    cmd.exit,
                    &cmd.command_rows,
                    &cmd.output_rows,
                ))?;
            }
            print_json_event(encoder.encode_frame(
                engine.snapshot(),
                engine.modes(),
                engine.title(),
                engine.active_top(),
            ))?;
            Ok(false)
        }
        PtyEvent::Exited(status) => {
            let code = i32::try_from(status.code)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "exit code overflow"))?;
            print_json_event(encoder.encode_exited(ProtocolExitStatus {
                code: Some(code),
                signal: None,
            }))?;
            Ok(true)
        }
        PtyEvent::Error(err) => {
            eprintln!("[perga raw-debug] error: {err}");
            Ok(true)
        }
    }
}

fn print_json_event(event: terminal_protocol::ProtocolEvent) -> io::Result<()> {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    serde_json::to_writer_pretty(&mut out, &event).map_err(io::Error::other)?;
    out.write_all(b"\n\n")?;
    out.flush()
}

fn stdin_ready(stdin: BorrowedFd<'_>) -> io::Result<bool> {
    let mut fds = [PollFd::new(stdin, PollFlags::POLLIN)];
    match nix::poll::poll(&mut fds, PollTimeout::ZERO) {
        Ok(_) => {
            let events = fds[0].revents().unwrap_or(PollFlags::empty());
            Ok(events.intersects(PollFlags::POLLIN | PollFlags::POLLHUP | PollFlags::POLLERR))
        }
        Err(nix::errno::Errno::EINTR) => Ok(false),
        Err(e) => Err(io::Error::from(e)),
    }
}
