//! `perga-server`:axum + tokio 把 `TerminalSession` 暴露成 WebSocket 服务。
//!
//! Phase 0 设计:**一会话一连接,只一个端点**。无 registry、无 HTTP 控制
//! 面 ── 直到 reconnect / 跨连接 session listing 真正需要时再加(CLAUDE.md
//! §不为未来写代码)。
//!
//! tokio runtime 是 server 专属的 side-pool;PTY / engine / session 全部
//! 仍跑在 sync 线程,只在 [`bridge`] 这一处缝合(CLAUDE.md §运行时模型)。

mod bridge;
mod error;
mod http;
mod profiles;
mod wire;
mod ws;

pub use error::ServerError;
pub use wire::ClientMessage;
pub use ws::SessionParams;

use axum::routing::{get, put};
use axum::Router;

/// 构造 axum Router。bin 和集成测试都通过它建路由,保证测试覆盖真实路径。
pub fn router() -> Router {
    Router::new()
        .route("/ws", get(ws::ws_handler))
        // host profile 的 CRUD —— 前端 SSH 配置 UI 走这一组。GET 列表 + POST 创建。
        .route("/api/hosts", get(http::list_hosts).post(http::create_host))
        // PUT 更新 + DELETE 删除(按 id 操作)。
        .route(
            "/api/hosts/:id",
            put(http::update_host).delete(http::delete_host),
        )
}
