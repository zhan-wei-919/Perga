//! PTY → protocol JSON 调试模式。
//!
//! 这里故意不进 raw mode,也不接前端:宿主 stdin 以行模式进 PTY,
//! `PtyEvent::Output` 经 `terminal-engine` 和 `terminal-protocol` 变成
//! pretty JSON。这样能单独看后端会发给前端的协议消息。

use std::io::{self, Write};
use std::os::fd::{AsRawFd, BorrowedFd};
use std::time::Duration;

use crossbeam_channel::Sender;
use nix::poll::{PollFd, PollFlags, PollTimeout};
use nix::unistd;
use pty::{PtyCommand, PtyConfig, PtyEvent, PtySession, PtySize};
use terminal_engine::{TerminalEngine, TerminalSize};
use terminal_protocol::{ExitStatus as ProtocolExitStatus, ProtocolEncoder};

const EVENT_TICK: Duration = Duration::from_millis(20);

/// 启动一个最小 protocol JSON debug session。
pub(crate) fn run(size: PtySize) -> Result<(), Box<dyn std::error::Error>> {
    let mut cfg = PtyConfig::with_default_shell(size);
    cfg.cwd = std::env::current_dir().ok();

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
    print_json_event(encoder.encode_frame(engine.snapshot(), engine.modes(), engine.title()))?;

    let stdin_fd = io::stdin().as_raw_fd();
    // SAFETY: stdin (fd 0) is valid for the process lifetime.
    let stdin_borrowed = unsafe { BorrowedFd::borrow_raw(stdin_fd) };
    let mut stdin_open = true;
    let mut buf = [0u8; 4096];

    loop {
        let mut done = false;
        match session.event_rx().recv_timeout(EVENT_TICK) {
            Ok(event) => {
                done = handle_event(event, &mut engine, &mut encoder, session.command_tx())?
            }
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => done = true,
        }

        while !done {
            match session.event_rx().try_recv() {
                Ok(event) => {
                    done = handle_event(event, &mut engine, &mut encoder, session.command_tx())?
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
                    stdin_open = false;
                    // Host EOF 对 shell 来说应当是 Ctrl-D,不是强制 Shutdown。
                    let _ = session.command_tx().send(PtyCommand::Write(vec![0x04]));
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
            print_json_event(encoder.encode_frame(
                engine.snapshot(),
                engine.modes(),
                engine.title(),
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
