//! `perga-server` 二进制。默认 bind `127.0.0.1:7777`,只接受 localhost
//! 连接 ── 远程访问由部署层负责(Tailscale / 反向代理 / 原生客户端 IPC)。
//!
//! 端口和 bind 地址通过环境变量调整:
//!
//! - `PERGA_BIND`(默认 `127.0.0.1:7777`)── 想换端口或绑 `0.0.0.0` 调试时用。
//! - `RUST_LOG` 沿用 tracing-subscriber EnvFilter 习惯,默认 `warn`。

use std::env;
use std::net::SocketAddr;

use tokio::net::TcpListener;
use tokio::signal;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    init_tracing();

    let bind: SocketAddr = env::var("PERGA_BIND")
        .unwrap_or_else(|_| "127.0.0.1:7777".to_string())
        .parse()?;

    let listener = TcpListener::bind(bind).await?;
    tracing::info!(addr = %bind, "perga.server.listening");

    let app = perga_server::router();

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

/// Ctrl-C 触发优雅退出 ── axum 停接新连接,在途 WS 各自结束后 serve 才返回。
async fn shutdown_signal() {
    if let Err(e) = signal::ctrl_c().await {
        tracing::error!(error = %e, "perga.server.signal_failed");
    }
    tracing::info!("perga.server.shutting_down");
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn"));
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(filter)
        .init();
}
