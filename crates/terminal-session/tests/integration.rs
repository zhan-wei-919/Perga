//! `terminal-session` 端到端集成测试。
//!
//! 起真实 PTY(`/bin/echo` / `/bin/cat`)驱动整条 backend 流水线 ── PTY 字节
//! → Engine → ProtocolEncoder → `ProtocolEvent` 消费者,以及反方向 SessionInput
//! → terminal-input → TransportCommand。**不**用 mock,protocol 契约一变就立刻打到。
//!
//! 整个文件依赖 `pty::PtyConfig` 起本地 PTY —— mobile target 上 `pty` crate
//! 编译为空,所以集成测试只在桌面 target 跑。

#![cfg(not(any(target_os = "android", target_os = "ios")))]

use std::path::PathBuf;
use std::time::{Duration, Instant};

use pty::PtyConfig;
use terminal_engine::TerminalSize;
use terminal_protocol::{ProtocolEvent, RowEntry};
use terminal_session::{SessionInput, TerminalSession};

// ─────────────────── helpers ───────────────────

fn pty_config(program: &str, args: &[&str]) -> PtyConfig {
    PtyConfig {
        program: PathBuf::from(program),
        args: args.iter().map(|s| s.to_string()).collect(),
        cwd: None,
        env_remove: Vec::new(),
        env: Vec::new(),
        size: TerminalSize::new(24, 80),
    }
}

/// 在一组 `RowEntry` 里找包含 `needle` 的 `Text`。
fn entries_contain(entries: &[RowEntry], needle: &str) -> bool {
    entries.iter().any(|e| match e {
        RowEntry::Text { s, .. } => s.contains(needle),
        RowEntry::Cells { cells } => {
            let s: String = cells.iter().map(|c| c.ch).collect();
            s.contains(needle)
        }
        RowEntry::Blank { .. } => false,
    })
}

fn event_contains(event: &ProtocolEvent, needle: &str) -> bool {
    match event {
        ProtocolEvent::Init { rows, .. } => rows.iter().any(|r| entries_contain(r, needle)),
        ProtocolEvent::Patch { dirty_rows, .. } => dirty_rows
            .iter()
            .any(|r| entries_contain(&r.entries, needle)),
        ProtocolEvent::CommandEnd { .. }
        | ProtocolEvent::Exited { .. }
        | ProtocolEvent::SessionError { .. } => false,
    }
}

/// 收事件直到 Exited 或 deadline,返回收到的事件序列。
fn drain_until_exited(session: &TerminalSession, deadline: Instant) -> Vec<ProtocolEvent> {
    let mut out = Vec::new();
    loop {
        match session.events().recv_deadline(deadline) {
            Ok(ev) => {
                let stop = matches!(ev, ProtocolEvent::Exited { .. });
                out.push(ev);
                if stop {
                    return out;
                }
            }
            Err(_) => return out,
        }
    }
}

// ─────────────────── tests ───────────────────

/// 全链路:PTY Output → Engine → Encoder → ProtocolEvent。
///
/// `/bin/echo hello` 必产出一行 "hello",我们应该看到:
/// 1. synthetic baseline Init(size 24x80,空 grid)
/// 2. 至少一个 Patch 含 "hello"
/// 3. 最后一条 Exited 且 code=Some(0)
#[test]
fn echo_round_trip_emits_init_patch_exited() {
    let session =
        TerminalSession::spawn_local(pty_config("/bin/echo", &["hello"])).expect("spawn /bin/echo");

    let deadline = Instant::now() + Duration::from_secs(5);
    let events = drain_until_exited(&session, deadline);

    // 第一条:synthetic Init,size 正确,grid 应该全空白(echo 还没跑)。
    match events.first() {
        Some(ProtocolEvent::Init { size, rows, .. }) => {
            assert_eq!(size.rows, 24);
            assert_eq!(size.cols, 80);
            // synthetic baseline:每行应该是单个 Blank{count: 80}。
            assert_eq!(rows.len(), 24);
            assert!(
                rows.iter()
                    .all(|r| matches!(r.as_slice(), [RowEntry::Blank { count: 80 }])),
                "synthetic Init should have all-blank rows"
            );
        }
        other => panic!("expected first event Init, got {other:?}"),
    }

    // 中间某条事件必含 "hello"。
    assert!(
        events.iter().any(|ev| event_contains(ev, "hello")),
        "expected an event containing 'hello' in the body"
    );

    // 最后一条:Exited 且 code=Some(0)。
    match events.last() {
        Some(ProtocolEvent::Exited { status, .. }) => {
            assert_eq!(status.code, Some(0), "echo should exit 0");
            assert_eq!(status.signal, None);
        }
        other => panic!("expected last event Exited, got {other:?}"),
    }
}

/// 反方向:SessionInput → terminal-input → PtyCommand → Engine → ProtocolEvent。
///
/// `cat` 回显 stdin 到 stdout,paste 一个 "ping\n" 后应该看到 Patch 含 "ping"。
/// Drop session 自动杀 cat ── PtySession::Drop 走 SIGHUP→500ms→SIGKILL。
#[test]
fn paste_round_trips_through_cat() {
    let session =
        TerminalSession::spawn_local(pty_config("/bin/cat", &[])).expect("spawn /bin/cat");

    session
        .input()
        .send(SessionInput::Paste("ping\n".into()))
        .expect("send paste");

    let deadline = Instant::now() + Duration::from_secs(3);
    let mut saw_ping = false;
    while Instant::now() < deadline {
        match session.events().recv_deadline(deadline) {
            Ok(ev) => {
                if event_contains(&ev, "ping") {
                    saw_ping = true;
                    break;
                }
            }
            Err(_) => break,
        }
    }
    assert!(saw_ping, "expected a Patch echoing 'ping'");

    // 不显式发 Exit ── drop session 触发 PtySession Drop,杀 cat,引擎线程收到
    // pty_event_rx Disconnected 后退出。下方 join 在 TerminalSession::drop 里发生。
}

/// `SessionInput::Resize` 改 engine grid + 下发 PtyCommand::Resize,且下一条
/// 事件应该是带新 size 的 Init(encoder 在 size 变化时强制发 Init)。
#[test]
fn resize_triggers_init_with_new_size() {
    // 起 `cat`,保持子进程 alive,不会自己退出干扰。
    let session =
        TerminalSession::spawn_local(pty_config("/bin/cat", &[])).expect("spawn /bin/cat");

    // 先丢掉 synthetic baseline。
    let baseline = session
        .events()
        .recv_timeout(Duration::from_secs(1))
        .expect("baseline init");
    match baseline {
        ProtocolEvent::Init { size, .. } => {
            assert_eq!(size.rows, 24);
            assert_eq!(size.cols, 80);
        }
        other => panic!("expected baseline Init, got {other:?}"),
    }

    // 发 resize,等下一个 Init(可能有几条 Patch 在中间 ── cat 启动有时产生
    // 0 输出,所以一般没有,但 robust 起见 drain 几条)。
    session
        .input()
        .send(SessionInput::Resize(TerminalSize::new(40, 120)))
        .expect("send resize");

    let deadline = Instant::now() + Duration::from_secs(2);
    let mut saw_resized_init = false;
    while Instant::now() < deadline {
        match session.events().recv_deadline(deadline) {
            Ok(ProtocolEvent::Init { size, .. }) if size.rows == 40 && size.cols == 120 => {
                saw_resized_init = true;
                break;
            }
            Ok(_) => continue,
            Err(_) => break,
        }
    }
    assert!(
        saw_resized_init,
        "expected an Init with rows=40 cols=120 after resize"
    );
}

/// OSC 133 全链路:一个直接 printf 出 OSC 133 标记 + 内容的进程,应该让事件流
/// 里出现一条带退出码的 `CommandEnd`。
///
/// 用 `printf` 而非交互式 shell ── 进程一次吐完所有字节再退出,无时序抖动。
#[test]
fn osc133_emits_command_end() {
    // printf body:`\033` = ESC,`\\` = 一个反斜杠(ST 第二字节)。
    let osc_a = r"\033]133;A\033\\";
    let osc_c = r"\033]133;C\033\\";
    let osc_d = r"\033]133;D;0\033\\";
    let body = format!("{osc_a}$ cmd\\r\\n{osc_c}out\\r\\n{osc_d}");
    let arg = format!("printf '{body}'");
    let session =
        TerminalSession::spawn_local(pty_config("/bin/sh", &["-c", &arg])).expect("spawn /bin/sh");

    let deadline = Instant::now() + Duration::from_secs(5);
    let events = drain_until_exited(&session, deadline);

    // 必有一条 CommandEnd,exit 0。
    let command_end = events.iter().find_map(|ev| match ev {
        ProtocolEvent::CommandEnd { exit, .. } => Some(*exit),
        _ => None,
    });
    assert_eq!(command_end, Some(Some(0)), "应有一条 exit 0 的 CommandEnd");

    assert!(
        matches!(events.last(), Some(ProtocolEvent::Exited { .. })),
        "最后一条应是 Exited"
    );
}
