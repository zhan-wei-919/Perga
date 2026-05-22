//! 回归:`perga raw-debug` 在管道 stdin 下的收尾行为。
//!
//! Bug A:host stdin EOF 时只合成一次 Ctrl-D(0x04),会和 shell 启动抢跑 ——
//!   shell 切到 readline raw mode 之前,canonical 行规把 0x04 当 VEOF、组成
//!   空行 EOF 后丢弃,raw-debug 随后永远等不到 shell 退出,整个进程卡死。
//! Bug B:EOF 修复曾加过「久无输出 → 判定卡死 → kill」的兜底,会把正在跑
//!   静默长命令(`sleep`)的 shell 误杀。

use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// 跑 `perga raw-debug`,喂 `input` 后关 stdin,返回 (是否在 limit 内退出, stdout)。
fn run_raw_debug(input: &[u8], limit: Duration) -> (bool, String) {
    let home = temp_home();
    fs::create_dir_all(&home).expect("create temp HOME");

    let mut child = Command::new(env!("CARGO_BIN_EXE_perga"))
        .arg("raw-debug")
        // 固定 bash:fish / pwsh 等不支持 shell 集成注入,不会有 command_end;
        // 那种环境下的失败与 EOF 收尾无关,会让本测试给出误导性结论。
        .env("SHELL", "/bin/bash")
        // shell integration 需要写 $HOME/.perga/shell。测试环境的真实 HOME
        // 可能在沙箱外只读,这里给子进程一个可写 HOME,否则不会有 OSC 133。
        .env("HOME", &home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn perga raw-debug");

    let mut stdin = child.stdin.take().expect("take stdin");
    let mut stdout = child.stdout.take().expect("take stdout");
    // stdout 必须并发抽干:raw-debug 每帧吐大段 JSON,pipe 缓冲填满会让它
    // 阻塞在 write 上,卡死的表现就和 bug 本身混在一起了。
    let drain = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stdout.read_to_string(&mut buf);
        buf
    });

    stdin.write_all(input).expect("write input");
    drop(stdin); // 关闭 host stdin → EOF

    let exited = wait_with_timeout(&mut child, limit);
    let output = drain.join().expect("join stdout drain");
    let _ = fs::remove_dir_all(&home);
    (exited, output)
}

fn temp_home() -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time before epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "perga-raw-debug-home-{}-{nonce}",
        std::process::id()
    ))
}

#[test]
fn raw_debug_terminates_on_piped_stdin() {
    if !Path::new("/bin/bash").exists() {
        eprintln!("skip raw_debug_terminates_on_piped_stdin: 无 /bin/bash");
        return;
    }
    let (exited, output) = run_raw_debug(
        b"echo perga-raw-debug-regression\n",
        Duration::from_secs(10),
    );
    assert!(exited, "raw-debug 在管道 stdin EOF 后未能自行退出(卡死)");
    assert!(
        output.contains("command_end"),
        "raw-debug 应在退出前 emit command_end"
    );
}

#[test]
fn raw_debug_does_not_kill_slow_silent_command() {
    if !Path::new("/bin/bash").exists() {
        eprintln!("skip raw_debug_does_not_kill_slow_silent_command: 无 /bin/bash");
        return;
    }
    // `sleep 6` 期间 shell 长时间无输出,但它没卡死。raw-debug 不能据此误判
    // 并 kill,必须等命令真正跑完。marker 用算术展开 `$((6*7))` 算出,所以
    // "perga42done" 只会出现在命令**输出**里,不会出现在被回显的命令行里。
    let (exited, output) = run_raw_debug(
        b"sleep 6; echo perga$((6*7))done\n",
        Duration::from_secs(25),
    );
    assert!(exited, "raw-debug 未在超时内退出");
    assert!(
        output.contains("perga42done"),
        "raw-debug 误杀了正在跑静默长命令的 shell —— 未等到命令输出"
    );
}

/// 轮询等子进程退出;超时则 kill 掉并返回 false。
fn wait_with_timeout(child: &mut Child, limit: Duration) -> bool {
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => {}
            Err(_) => return false,
        }
        if start.elapsed() > limit {
            let _ = child.kill();
            let _ = child.wait();
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}
