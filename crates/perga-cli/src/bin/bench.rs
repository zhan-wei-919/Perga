//! `perga-bench`:后端 sync 路径性能基准。
//!
//! 测的是 server 热循环里这一段:
//!
//! ```text
//!   PtyEvent::Output(bytes)
//!     engine.feed(bytes)           ── alacritty/vte 状态机推进
//!     engine.snapshot()            ── grid → Snapshot 转换 + cell 分配
//!     encoder.encode_frame(...)    ── 与上帧 diff,产 Init/Patch
//!     serde_json::to_string(...)   ── wire 序列化
//! ```
//!
//! 不测 transport(那是 `crates/perga-server/tests/rtt.rs`),不测客户端渲染。
//! 这是定位 server CPU 热点的工具。
//!
//! 用法:
//!   cargo run --release -p perga-cli --bin perga-bench
//!   cargo run --release -p perga-cli --bin perga-bench -- --total 100000000 --chunk 4096
//!
//! **必须用 `--release`**。debug 构建下 alacritty / vte 比 release 慢一个量级,
//! 测出来的数字没有参考价值。

use std::time::{Duration, Instant};

use terminal_engine::{TerminalEngine, TerminalSize};
use terminal_protocol::ProtocolEncoder;

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "-h" || a == "--help") {
        print_help();
        return Ok(());
    }

    let rows: u16 = parse_arg(&args, "--rows", 24);
    let cols: u16 = parse_arg(&args, "--cols", 80);
    let chunk: usize = parse_arg(&args, "--chunk", 1024);
    let total: usize = parse_arg(&args, "--total", 50_000_000);

    println!("== Perga sync-path bench ==");
    if cfg!(debug_assertions) {
        println!("!! WARNING: debug build. Rebuild with --release for meaningful numbers.");
    }
    println!("grid: {rows}×{cols}, chunk: {chunk} bytes, total: {total} bytes");

    let payload = make_payload(chunk);
    let mut engine = TerminalEngine::new(TerminalSize::new(rows, cols));
    let mut encoder = ProtocolEncoder::new();

    // Warmup ── 让 CPU cache / 分支预测器进入稳态。
    for _ in 0..20 {
        engine.feed(&payload);
        let _ = engine.drain_pending_writes();
        let cleared = engine.scrollback_cleared();
        let scrolled = engine.take_scrolled_rows();
        let _ = encoder.encode_frame(
            engine.snapshot(),
            engine.modes(),
            engine.title(),
            &scrolled,
            cleared,
        );
    }

    let cap = total / chunk + 16;
    let mut feed_d = Vec::with_capacity(cap);
    let mut snap_d = Vec::with_capacity(cap);
    let mut enc_d = Vec::with_capacity(cap);
    let mut json_d = Vec::with_capacity(cap);
    let mut wire_bytes: usize = 0;

    let wall_start = Instant::now();
    let mut bytes_done = 0usize;
    while bytes_done < total {
        let t0 = Instant::now();
        engine.feed(&payload);
        let _ = engine.drain_pending_writes();
        let t1 = Instant::now();
        let snap = engine.snapshot();
        let modes = engine.modes();
        let title = engine.title();
        let cleared = engine.scrollback_cleared();
        let scrolled = engine.take_scrolled_rows();
        let t2 = Instant::now();
        let ev = encoder.encode_frame(snap, modes, title, &scrolled, cleared);
        let t3 = Instant::now();
        let json = serde_json::to_string(&ev).map_err(|e| format!("serialize: {e}"))?;
        let t4 = Instant::now();

        feed_d.push(t1 - t0);
        snap_d.push(t2 - t1);
        enc_d.push(t3 - t2);
        json_d.push(t4 - t3);
        wire_bytes += json.len();

        bytes_done += payload.len();
    }
    let wall = wall_start.elapsed();

    println!();
    print_dur_stats("feed       ", &feed_d);
    print_dur_stats("snapshot   ", &snap_d);
    print_dur_stats("encode     ", &enc_d);
    print_dur_stats("json       ", &json_d);

    let mib_in = bytes_done as f64 / 1_048_576.0;
    let mib_wire = wire_bytes as f64 / 1_048_576.0;
    println!();
    println!("=== aggregate ===");
    println!("wall:        {:?}", wall);
    println!("input:       {:.2} MiB", mib_in);
    println!("input rate:  {:.1} MiB/s", mib_in / wall.as_secs_f64());
    println!("frames:      {}", feed_d.len());
    println!(
        "frame rate:  {:.0} fps (= one Patch per PtyEvent::Output)",
        feed_d.len() as f64 / wall.as_secs_f64()
    );
    println!("wire:        {:.2} MiB", mib_wire);
    println!(
        "wire ratio:  {:.2}× (output JSON / input bytes)",
        mib_wire / mib_in
    );
    Ok(())
}

fn print_help() {
    println!("Usage: perga-bench [OPTIONS]");
    println!();
    println!("Options:");
    println!("  --rows N      Grid 行数 (default: 24)");
    println!("  --cols N      Grid 列数 (default: 80)");
    println!("  --chunk N     PTY 输出每帧字节数 (default: 1024)");
    println!("  --total N     总输入字节数 (default: 50000000)");
}

fn parse_arg<T: std::str::FromStr>(args: &[String], flag: &str, default: T) -> T {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// 合成 PTY 字节流。混合颜色 + 文本 + 换行,模拟普通 shell 输出。
///
/// 不用 alt-screen / 复杂光标定位 ── 那种场景另写一个 fixture(待后续真要
/// 测 vim / htop hot path 时加)。
fn make_payload(size: usize) -> Vec<u8> {
    // 用单宽 ASCII + SGR 颜色码,贴近 ls / cat / make 这类 stream-y workload。
    let lines: &[&[u8]] = &[
        b"\x1b[36m-rwxr-xr-x\x1b[0m 1 root root  12345 Jan 01 12:34 some_filename.txt\n",
        b"\x1b[33mdrwxr-xr-x\x1b[0m 2 root root   4096 Jan 02 13:45 a_directory_here/\n",
        b"\x1b[32m  total \x1b[1m1234\x1b[0m blocks of various kinds across files\n",
        b"plain text without colors fills the rest of the row up to 80 cols wide.\n",
    ];
    let mut out = Vec::with_capacity(size + 128);
    while out.len() < size {
        for l in lines {
            out.extend_from_slice(l);
            if out.len() >= size {
                break;
            }
        }
    }
    out.truncate(size);
    out
}

fn print_dur_stats(label: &str, ds: &[Duration]) {
    if ds.is_empty() {
        println!("{label}: no samples");
        return;
    }
    let mut sorted: Vec<_> = ds.to_vec();
    sorted.sort();
    let q = |p: f64| -> Duration {
        let i = ((sorted.len() - 1) as f64 * p).round() as usize;
        sorted[i]
    };
    let total: Duration = sorted.iter().sum();
    let mean = total / sorted.len() as u32;
    let last = sorted.last().copied().unwrap_or_default();
    println!(
        "{label}  n={:>5}  mean={:>9?}  p50={:>9?}  p99={:>9?}  p999={:>9?}  max={:>9?}",
        sorted.len(),
        mean,
        q(0.50),
        q(0.99),
        q(0.999),
        last,
    );
}
