//! PTY raw-byte 调试模式。
//!
//! 这里故意不进 raw mode,也不接 terminal-engine:宿主 stdin 以行模式进
//! PTY,`PtyEvent::Output` 直接按 escaped byte string 打印。这样能单独看
//! shell / TUI 程序吐出的原始 PTY 字节,不掺前端渲染或 parser 适配层。

use std::io::{self, Write};
use std::os::fd::{AsRawFd, BorrowedFd};
use std::time::Duration;

use nix::poll::{PollFd, PollFlags, PollTimeout};
use nix::unistd;
use pty::{PtyCommand, PtyConfig, PtyEvent, PtySession, PtySize};

const EVENT_TICK: Duration = Duration::from_millis(20);

/// 启动一个最小 escaped-output debug session。
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
        "[perga raw-debug] type commands normally; Ctrl-D shuts down. Output is escaped raw PTY chunks."
    );

    let session = PtySession::spawn(cfg)?;
    let stdin_fd = io::stdin().as_raw_fd();
    // SAFETY: stdin (fd 0) is valid for the process lifetime.
    let stdin_borrowed = unsafe { BorrowedFd::borrow_raw(stdin_fd) };
    let mut stdin_open = true;
    let mut buf = [0u8; 4096];

    loop {
        let mut done = false;
        match session.event_rx().recv_timeout(EVENT_TICK) {
            Ok(event) => done = handle_event(event)?,
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => done = true,
        }

        while !done {
            match session.event_rx().try_recv() {
                Ok(event) => done = handle_event(event)?,
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

fn handle_event(event: PtyEvent) -> io::Result<bool> {
    match event {
        PtyEvent::Output(data) => {
            print_raw_chunk(&data)?;
            Ok(false)
        }
        PtyEvent::Exited(status) => {
            eprintln!(
                "[perga raw-debug] exited: code={} success={}",
                status.code, status.success
            );
            Ok(true)
        }
        PtyEvent::Error(err) => {
            eprintln!("[perga raw-debug] error: {err}");
            Ok(true)
        }
    }
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

fn print_raw_chunk(data: &[u8]) -> io::Result<()> {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    writeln!(out, "[raw {} bytes] \"{}\"", data.len(), escape_bytes(data))?;
    out.flush()
}

fn escape_bytes(data: &[u8]) -> String {
    let mut escaped = String::new();
    for b in data {
        match *b {
            b'\n' => escaped.push_str("\\n"),
            b'\r' => escaped.push_str("\\r"),
            b'\t' => escaped.push_str("\\t"),
            b'\\' => escaped.push_str("\\\\"),
            b'"' => escaped.push_str("\\\""),
            0x20..=0x7e => escaped.push(*b as char),
            other => {
                use std::fmt::Write as _;
                let _ = write!(escaped, "\\x{other:02x}");
            }
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::escape_bytes;

    #[test]
    fn escape_bytes_keeps_control_sequences_visible() {
        assert_eq!(
            escape_bytes(b"\x1b[31mred\x1b[0m\r\n"),
            "\\x1b[31mred\\x1b[0m\\r\\n"
        );
    }
}
