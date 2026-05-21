//! WS 端到端 RTT 测试:测「客户端发一个 key → 服务端回一帧 Patch」的总耗时。
//!
//! 这个数字反映用户实际体验的输入响应延迟:
//!
//! ```text
//!   key JSON        → tungstenite encode → WS frame
//!     → tokio_io::write → loopback TCP → tokio_io::read
//!     → tungstenite decode → serde_json::from_str
//!     → ClientMessage::into_session_input
//!     → crossbeam send → engine_thread.select recv
//!     → engine.feed(bytes) → snapshot + encode_frame
//!     → crossbeam send → bridge OS thread recv
//!     → tokio mpsc send → ws_tx
//!     → serde_json::to_string → WS frame → loopback TCP
//!     → client decode → next frame ready
//! ```
//!
//! 跑法(必须 release 才有参考价值):
//!   cargo test --release -p perga-server --test rtt -- --nocapture
//!
//! 这条测试故意**不**作为 CI gate;assert 只挡明显异常(p99 > 5s),
//! 真正价值是 `--nocapture` 打出的统计数字。

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use futures_util::SinkExt;
use futures_util::StreamExt;
use tokio::net::TcpListener;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;

const SAMPLES: usize = 200;
const SETTLE_WINDOW: Duration = Duration::from_millis(500);

async fn spawn_test_server() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, perga_server::router()).await;
    });
    addr
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn key_to_patch_rtt() {
    let addr = spawn_test_server().await;
    let url = format!("ws://{addr}/ws?rows=24&cols=80");

    let (mut sock, _resp) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("ws handshake");

    // Shell 启动会喷一串 Init/Patch ── 等到至少 500ms 没新帧才开始测,
    // 避免把启动开销算到 RTT 里。
    drain_until_quiet(&mut sock, SETTLE_WINDOW).await;

    let payload = r#"{"type":"key","key":{"type":"char","value":"a"}}"#;
    let mut rtts: Vec<Duration> = Vec::with_capacity(SAMPLES);
    for i in 0..SAMPLES {
        let t0 = Instant::now();
        sock.send(Message::Text(payload.into()))
            .await
            .expect("send");
        // 等下一帧。shell 在 echo 模式会把 'a' 回写,产 Patch。
        let frame = timeout(Duration::from_secs(5), sock.next())
            .await
            .unwrap_or_else(|_| panic!("rtt sample {i} timeout"))
            .expect("stream still open")
            .expect("frame ok");
        match frame {
            Message::Text(_) => {}
            other => panic!("expected text frame, got {other:?}"),
        }
        rtts.push(t0.elapsed());
    }

    print_stats(&rtts);

    // Loose sanity gate ── 真正解读靠肉眼看打印的数字。
    rtts.sort();
    let p99 = rtts[(rtts.len() as f64 * 0.99) as usize];
    assert!(
        p99 < Duration::from_secs(5),
        "rtt p99 unreasonable: {p99:?}",
    );
}

/// 喂掉所有"在 `quiet_for` 时间窗里"陆续到达的帧。窗口期内每收到一帧
/// 就重置计时,直到完整一个 `quiet_for` 没有新帧。
async fn drain_until_quiet(
    sock: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    quiet_for: Duration,
) {
    loop {
        match timeout(quiet_for, sock.next()).await {
            // 收到帧 ── 继续等下一帧。
            Ok(Some(Ok(_))) => continue,
            // 窗口期内无新帧 ── 已经 settle。
            Err(_) => return,
            // 流关了 / 帧错误 ── 异常,直接 return 让后续 send 报错。
            Ok(None) | Ok(Some(Err(_))) => return,
        }
    }
}

fn print_stats(rtts: &[Duration]) {
    let mut sorted: Vec<_> = rtts.to_vec();
    sorted.sort();
    let q = |p: f64| -> Duration {
        let i = ((sorted.len() - 1) as f64 * p).round() as usize;
        sorted[i]
    };
    let total: Duration = sorted.iter().sum();
    let mean = total / sorted.len() as u32;
    println!();
    println!(
        "=== Perga WS RTT (key → patch), {} samples ===",
        sorted.len()
    );
    println!("  mean:  {:?}", mean);
    println!("  p50:   {:?}", q(0.50));
    println!("  p90:   {:?}", q(0.90));
    println!("  p99:   {:?}", q(0.99));
    println!("  max:   {:?}", sorted.last().copied().unwrap_or_default());
    println!();
}
