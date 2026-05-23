//! `perga-ssh-probe`:**手动**验证 SSH backend 字节通路的工具。
//!
//! 不依赖前端 / `perga-server` / `terminal-session`,直接构造
//! [`ssh::SshSession`],灌一段命令、读 N 秒输出、打印,然后关闭。出问题时
//! 这是分辨「`crates/ssh` 自身的 bug 还是上层缝合 bug」的最近现场。
//!
//! 用法:
//!   perga-ssh-probe --host <host> --user <user> [--port 22] [--cmd 'ls\n']
//!
//! 前置条件:
//! - `SSH_AUTH_SOCK` 已设(`ssh-agent` 跑着,并 `ssh-add` 加好私钥)。
//! - `~/.ssh/known_hosts`(默认路径)对当前 host 已 TOFU,或允许新增。

use std::io::{self, Write};
use std::time::{Duration, Instant};

use ssh::{Auth, SshConfig, SshSession};
use transport::{TerminalSize, Transport, TransportCommand, TransportEvent};

/// 默认运行窗口 —— 起 PTY 时告诉远端 shell 的初始尺寸。
const DEFAULT_SIZE: TerminalSize = TerminalSize::new(24, 80);
/// 收满多久无输出就停止。这是 probe 工具,不是长连接 demo。
const QUIET_DEADLINE: Duration = Duration::from_secs(3);

fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(io::stderr)
        .init();

    let args = parse_args()?;
    eprintln!(
        "[probe] connect to {}@{}:{} (auth=agent)",
        args.user, args.host, args.port
    );

    let session = SshSession::spawn(
        SshConfig {
            host: args.host,
            port: args.port,
            user: args.user,
            auth: Auth::Agent,
            known_hosts_path: None,
        },
        DEFAULT_SIZE,
    )?;

    eprintln!(
        "[probe] connected. sending command, then reading output until {QUIET_DEADLINE:?} idle."
    );

    session
        .command_tx()
        .send(TransportCommand::Write(args.cmd.into_bytes()))?;

    let stdout = io::stdout();
    let mut out = stdout.lock();
    let mut last_event = Instant::now();
    let overall_deadline = Instant::now() + Duration::from_secs(30);

    loop {
        let now = Instant::now();
        if now >= overall_deadline {
            eprintln!("[probe] 30s overall deadline reached");
            break;
        }
        let timeout = std::cmp::min(
            QUIET_DEADLINE.saturating_sub(now.duration_since(last_event)),
            Duration::from_millis(100),
        );
        match session.event_rx().recv_timeout(timeout) {
            Ok(TransportEvent::Output(data)) => {
                out.write_all(&data)?;
                out.flush()?;
                last_event = Instant::now();
            }
            Ok(TransportEvent::Exited(status)) => {
                eprintln!(
                    "\n[probe] session exited: code={:?} signal={:?}",
                    status.code, status.signal
                );
                break;
            }
            Ok(TransportEvent::Error(e)) => {
                eprintln!("\n[probe] transport error: {e}");
                break;
            }
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                if last_event.elapsed() >= QUIET_DEADLINE {
                    eprintln!("\n[probe] {QUIET_DEADLINE:?} idle, stopping");
                    break;
                }
            }
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                eprintln!("\n[probe] event channel disconnected");
                break;
            }
        }
    }

    drop(session);
    Ok(())
}

struct Args {
    host: String,
    port: u16,
    user: String,
    cmd: String,
}

/// 极简 argparse —— 没有第三方依赖,只够 probe 工具用。`--cmd` 默认 `ls\n`。
fn parse_args() -> Result<Args, String> {
    let mut host: Option<String> = None;
    let mut user: Option<String> = None;
    let mut port: u16 = 22;
    let mut cmd: String = "ls\n".into();
    let mut iter = std::env::args().skip(1);
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--host" => host = Some(iter.next().ok_or("--host missing value")?),
            "--user" => user = Some(iter.next().ok_or("--user missing value")?),
            "--port" => {
                let v = iter.next().ok_or("--port missing value")?;
                port = v.parse().map_err(|e| format!("--port {v}: {e}"))?;
            }
            "--cmd" => cmd = iter.next().ok_or("--cmd missing value")?,
            "-h" | "--help" => {
                println!(
                    "usage: perga-ssh-probe --host <host> --user <user> [--port 22] [--cmd 'ls\\n']"
                );
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(Args {
        host: host.ok_or("--host required")?,
        user: user.ok_or("--user required")?,
        port,
        cmd,
    })
}
