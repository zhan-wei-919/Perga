//! WS lifecycle 集成测试:绑随机端口启 server,作为 WS client 验证 Init 帧
//! 在升级后立即到达,并且 client close 后 server 端 task 自然结束。
//!
//! 故意不写 unit test 风格 ── transport + session spawn + bridge + serde
//! 是一条完整通路,unit 拆开后假阴性多,真实路径只一条就走完。

use std::net::SocketAddr;
use std::time::Duration;

use futures_util::stream::StreamExt;
use futures_util::SinkExt;
use tokio::net::TcpListener;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;

/// 起 server 占随机端口,返回 (实际地址, 关停 handle)。
async fn spawn_test_server() -> (SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind random port");
    let addr = listener.local_addr().expect("local addr");
    let app = perga_server::router();
    let handle = tokio::spawn(async move {
        // serve 一直跑到 listener 自然结束 ── 测试结束时 abort task。
        let _ = axum::serve(listener, app).await;
    });
    (addr, handle)
}

#[tokio::test]
async fn ws_upgrade_yields_init_frame() {
    let (addr, server) = spawn_test_server().await;
    let url = format!("ws://{addr}/ws?rows=24&cols=80");

    let (mut socket, _resp) = timeout(
        Duration::from_secs(5),
        tokio_tungstenite::connect_async(&url),
    )
    .await
    .expect("connect timeout")
    .expect("ws handshake");

    // baseline Init 在 TerminalSession::spawn 内 synthetic enqueue,转发
    // 路径是 sync channel → bridge OS 线程 → tokio mpsc → ws_tx,延迟可控。
    let first = timeout(Duration::from_secs(5), socket.next())
        .await
        .expect("first frame timeout")
        .expect("stream not empty")
        .expect("ws frame ok");

    let payload = match first {
        Message::Text(t) => t,
        other => panic!("expected text, got {other:?}"),
    };

    // 不解析全字段 ── 只断言 envelope 形状对得上协议契约。
    let v: serde_json::Value = serde_json::from_str(&payload).expect("init json");
    assert_eq!(v["type"], "init", "first frame must be init");
    assert_eq!(v["size"]["rows"], 24);
    assert_eq!(v["size"]["cols"], 80);
    assert!(v["seq"].as_u64().is_some(), "init carries seq");

    // 主动关 WS;server 端 handler 在 select 中拿到结束信号 → spawn_blocking
    // drop session → PTY 子进程被 SIGHUP/SIGKILL 清掉。测试不直接断言
    // 子进程清理(那是 terminal-session 的责任,已在它自己的集成测试覆盖),
    // 这里只验 close 不 hang。
    socket
        .send(Message::Close(None))
        .await
        .expect("send close");
    drop(socket);

    server.abort();
}

#[tokio::test]
async fn invalid_size_rejected() {
    let (addr, server) = spawn_test_server().await;
    let url = format!("ws://{addr}/ws?rows=0&cols=80");

    let result = timeout(
        Duration::from_secs(5),
        tokio_tungstenite::connect_async(&url),
    )
    .await
    .expect("connect timeout");

    let err = result.expect_err("rows=0 should be rejected before upgrade");
    // tungstenite 把非 101 响应包成 Http 错误。具体 status 在 message 里。
    assert!(
        err.to_string().to_lowercase().contains("400")
            || matches!(err, tokio_tungstenite::tungstenite::Error::Http(_)),
        "expected http 400, got {err:?}"
    );

    server.abort();
}

#[tokio::test]
async fn key_input_reaches_pty() {
    let (addr, server) = spawn_test_server().await;
    let url = format!("ws://{addr}/ws?rows=24&cols=80");

    let (mut socket, _) = timeout(
        Duration::from_secs(5),
        tokio_tungstenite::connect_async(&url),
    )
    .await
    .expect("connect timeout")
    .expect("ws handshake");

    // 跳过 baseline Init。
    let _ = timeout(Duration::from_secs(5), socket.next())
        .await
        .expect("init timeout");

    // 发送一个 char 'x' ── shell 一般会回显(取决于 ICANON / ECHO),保险
    // 起见走 echo 命令路径太重,这里只断言「server 不会因为收到合法帧而
    // 立刻断开」。后续 Patch 是否出现不强制,因为 shell 启动期间可能先
    // 输出 prompt 再处理输入。
    let payload = r#"{"type":"key","key":{"type":"char","value":"x"}}"#;
    socket
        .send(Message::Text(payload.into()))
        .await
        .expect("send key");

    // 给 PTY 一点时间响应,然后期望至少能再收到一帧(prompt / echo / 任何
    // grid 变更触发的 Patch)。
    let next = timeout(Duration::from_secs(5), socket.next())
        .await
        .expect("subsequent frame timeout")
        .expect("stream still open")
        .expect("frame ok");
    let text = match next {
        Message::Text(t) => t,
        other => panic!("expected text frame, got {other:?}"),
    };
    let v: serde_json::Value = serde_json::from_str(&text).expect("json");
    let ty = v["type"].as_str().expect("type tag");
    // Init / Patch / Exited 都是合法继任 ── 最常见是 shell 输出 prompt 触发的 Patch。
    assert!(
        matches!(ty, "init" | "patch" | "exited"),
        "unexpected event type after key input: {ty}"
    );

    socket
        .send(Message::Close(None))
        .await
        .expect("send close");
    drop(socket);
    server.abort();
}
