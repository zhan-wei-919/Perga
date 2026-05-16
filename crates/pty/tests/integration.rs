//! `pty` crate 的集成测试。每个测试独立 spawn 一个 `PtySession`,
//! 用各种小工具(echo / cat / sh / stty / sleep)验证字节通路与生命周期。

use std::path::PathBuf;
use std::time::{Duration, Instant};

use crossbeam_channel::Receiver;
use pty::{PtyCommand, PtyConfig, PtyError, PtyEvent, PtySession, PtySize};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(3);

fn collect_until<F>(rx: &Receiver<PtyEvent>, predicate: F, timeout: Duration) -> Vec<PtyEvent>
where
    F: Fn(&PtyEvent) -> bool,
{
    let mut events = Vec::new();
    let deadline = Instant::now() + timeout;
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        match rx.recv_timeout(left) {
            Ok(ev) => {
                let stop = predicate(&ev);
                events.push(ev);
                if stop {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    events
}

fn aggregate_output(events: &[PtyEvent]) -> Vec<u8> {
    let mut buf = Vec::new();
    for ev in events {
        if let PtyEvent::Output(data) = ev {
            buf.extend_from_slice(data);
        }
    }
    buf
}

fn config_for(program: &str, args: &[&str]) -> PtyConfig {
    let mut cfg = PtyConfig::new(PathBuf::from(program), PtySize::new(24, 80));
    cfg.args = args.iter().map(|s| (*s).to_string()).collect();
    cfg
}

#[test]
fn echo_roundtrip() {
    let session = PtySession::spawn(config_for("/bin/echo", &["hello"])).expect("spawn echo");
    let events = collect_until(
        session.event_rx(),
        |ev| matches!(ev, PtyEvent::Exited(_)),
        DEFAULT_TIMEOUT,
    );
    let out = aggregate_output(&events);
    assert!(
        out.windows(5).any(|w| w == b"hello"),
        "output should contain 'hello', got {:?}",
        String::from_utf8_lossy(&out)
    );
    let exited = events.iter().find_map(|ev| match ev {
        PtyEvent::Exited(s) => Some(*s),
        _ => None,
    });
    let status = exited.expect("expected Exited event");
    assert!(status.success, "echo exit status should be success");
}

#[test]
fn cat_write_then_shutdown() {
    let session = PtySession::spawn(config_for("/bin/cat", &[])).expect("spawn cat");
    session
        .command_tx()
        .send(PtyCommand::Write(b"abc\n".to_vec()))
        .expect("send write");

    // 等 cat 把 echo 回的字节流读出来
    let echo_events = collect_until(
        session.event_rx(),
        |ev| match ev {
            PtyEvent::Output(d) => d.windows(3).any(|w| w == b"abc"),
            _ => false,
        },
        DEFAULT_TIMEOUT,
    );
    let echoed = aggregate_output(&echo_events);
    assert!(
        echoed.windows(3).any(|w| w == b"abc"),
        "cat should echo 'abc', got {:?}",
        String::from_utf8_lossy(&echoed)
    );

    session
        .command_tx()
        .send(PtyCommand::Shutdown)
        .expect("send shutdown");
    let tail = collect_until(
        session.event_rx(),
        |ev| matches!(ev, PtyEvent::Exited(_)),
        DEFAULT_TIMEOUT,
    );
    assert!(
        tail.iter().any(|ev| matches!(ev, PtyEvent::Exited(_))),
        "should receive Exited after shutdown, got {tail:?}"
    );
    assert!(
        !tail.iter().any(|ev| matches!(ev, PtyEvent::Error(_))),
        "EOF on normal close should not surface as Error, got {tail:?}"
    );
}

#[test]
fn pty_size_reaches_child_24x80() {
    let session = PtySession::spawn({
        let mut cfg = config_for("/bin/sh", &["-c", "stty size"]);
        cfg.size = PtySize::new(24, 80);
        cfg
    })
    .expect("spawn sh");
    let events = collect_until(
        session.event_rx(),
        |ev| matches!(ev, PtyEvent::Exited(_)),
        DEFAULT_TIMEOUT,
    );
    let out = String::from_utf8_lossy(&aggregate_output(&events)).into_owned();
    assert!(
        out.contains("24 80"),
        "stty size should report 24 80, got {out:?}"
    );
}

#[test]
fn pty_size_reaches_child_40x120() {
    let session = PtySession::spawn({
        let mut cfg = config_for("/bin/sh", &["-c", "stty size"]);
        cfg.size = PtySize::new(40, 120);
        cfg
    })
    .expect("spawn sh");
    let events = collect_until(
        session.event_rx(),
        |ev| matches!(ev, PtyEvent::Exited(_)),
        DEFAULT_TIMEOUT,
    );
    let out = String::from_utf8_lossy(&aggregate_output(&events)).into_owned();
    assert!(
        out.contains("40 120"),
        "stty size should report 40 120, got {out:?}"
    );
}

#[test]
fn spawn_nonexistent_program_returns_err() {
    let result = PtySession::spawn(config_for("/no/such/binary-perga-test", &[]));
    match result {
        Err(PtyError::Spawn(_)) => {}
        Ok(_) => panic!("spawn should not succeed for /no/such/binary-perga-test"),
        Err(other) => panic!("expected PtyError::Spawn, got {other:?}"),
    }
}

#[test]
fn drop_kills_child() {
    let start = Instant::now();
    {
        let _session =
            PtySession::spawn(config_for("/bin/sleep", &["30"])).expect("spawn sleep 30");
        // 立即 drop
    }
    let elapsed = start.elapsed();
    assert!(
        elapsed < Duration::from_secs(5),
        "drop should kill the long-running child quickly, took {elapsed:?}"
    );
}

/// Regression:即使 child 主动忽略 SIGHUP,Drop 也必须能在 budget 内收掉它 ——
/// 验证 SIGHUP → grace → SIGKILL pgroup 的升级路径真的生效。
///
/// `sh -c "trap '' HUP; while :; do sleep 60; done"` 是一个 SIGHUP-resistant
/// 的 shell:HUP 信号到 pgroup 时,sh 自身被 trap 拦下不退,而内层 sleep 即使
/// 被 HUP 杀掉,外层 while 立刻再起一个,只有 SIGKILL pgroup 才能把整树收掉。
#[test]
fn drop_kills_uncooperative_child() {
    let start = Instant::now();
    {
        let _session = PtySession::spawn(config_for(
            "/bin/sh",
            &["-c", "trap '' HUP; while :; do sleep 60; done"],
        ))
        .expect("spawn resistant sh");
        // 等 sh 真的 install trap 再 drop。否则我们和 trap install 抢跑,
        // SIGHUP 可能在 trap 之前送达,测试退化成 cooperative case。
        std::thread::sleep(Duration::from_millis(200));
    }
    let elapsed = start.elapsed();
    // 200ms(等 trap install)+ 500ms(SIGKILL escalation)+ join 开销。
    // 给到 2s 上限,本质是「不能等到 join_handles_with_timeout 的 2s detach」。
    assert!(
        elapsed < Duration::from_millis(1800),
        "escalation should kill HUP-trapped child within budget, took {elapsed:?}"
    );
}

/// Regression:large output 必须在 `Exited` 之前全部到达。曾经 waiter 用 200ms
/// 超时,reader 慢一拍时尾部 chunk 会跟在 `Exited` 之后。
#[test]
fn no_output_lost_before_exit() {
    // ~100 KB 的 "hello\n" 重复。PTY OPOST 会把 \n → \r\n,实际更大。
    let session = PtySession::spawn(config_for(
        "/bin/sh",
        &["-c", "yes hello | head -c 100000; exit 0"],
    ))
    .expect("spawn sh");

    let mut total = 0usize;
    let mut saw_exit = false;
    let deadline = Instant::now() + Duration::from_secs(10);
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        match session.event_rx().recv_timeout(left) {
            Ok(PtyEvent::Output(data)) => {
                assert!(!saw_exit, "Output arrived AFTER Exited — protocol violated");
                total += data.len();
            }
            Ok(PtyEvent::Exited(status)) => {
                assert!(status.success, "child should exit 0");
                saw_exit = true;
                break;
            }
            Ok(PtyEvent::Error(e)) => panic!("unexpected fatal error: {e:?}"),
            Err(_) => break,
        }
    }
    assert!(saw_exit, "should have received Exited within deadline");
    assert!(
        total >= 99_000,
        "expected at least ~100 KB of output before Exited, got {total} bytes"
    );
}

/// Regression:resize 失败(或正常)都**不应**触发 `PtyEvent::Error`。Error 的
/// 契约是「致命」,曾经 resize 失败时走 Error,会让 CLI 误判会话已死。
#[test]
fn resize_does_not_emit_fatal_error() {
    let session = PtySession::spawn(config_for("/bin/cat", &[])).expect("spawn cat");

    // 多次 resize,包括一个合法值和一个极端值(可能被内核拒绝)。
    for &(rows, cols) in &[(40u16, 120u16), (10, 40), (1, 1), (50, 200)] {
        session
            .command_tx()
            .send(PtyCommand::Resize(PtySize::new(rows, cols)))
            .expect("send resize");
    }

    // 写一字节,等它回来,确认写通路依旧活着。
    session
        .command_tx()
        .send(PtyCommand::Write(b"x\n".to_vec()))
        .expect("send write");

    let events = collect_until(
        session.event_rx(),
        |ev| match ev {
            PtyEvent::Output(d) => d.contains(&b'x'),
            _ => false,
        },
        DEFAULT_TIMEOUT,
    );
    assert!(
        !events.iter().any(|ev| matches!(ev, PtyEvent::Error(_))),
        "resize must never surface as a fatal Error event, got {events:?}"
    );
    let echoed = aggregate_output(&events);
    assert!(
        echoed.contains(&b'x'),
        "write path should still work after resizes, got {:?}",
        String::from_utf8_lossy(&echoed)
    );
}
