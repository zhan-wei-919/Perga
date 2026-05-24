//! `perga-server`:axum + tokio 把 `TerminalSession` 暴露成 WebSocket / HTTP 服务。
//!
//! **角色:Rust core 的开发、测试和 daemon prototype adapter**。长期产品入口转向
//! 各平台原生客户端;本 crate 保留为本地服务、协议 replay 和集成测试入口。
//!
//! 与协议无关的核心(profile CRUD、ClientMessage、session 工厂)在 `perga-core`。
//! 本 crate 只做 axum / WS 缝合 + 默认路径解析。
//!
//! tokio runtime 是 server 专属的 side-pool;PTY / engine / session 全部
//! 仍跑在 sync 线程,只在 [`bridge`] 这一处缝合(CLAUDE.md §运行时模型)。
//!
//! **平台**:仅桌面(Linux / macOS / Windows)。直接调 `perga_core::open_local`,
//! 不做 mobile target gate。移动端客户端路线见
//! `docs/cross-platform-native-client.md`,不以本 crate 作为第一阶段入口。

mod bridge;
mod error;
mod http;
mod ws;

pub use error::ServerError;
pub use perga_core::wire::ClientMessage;
pub use ws::SessionParams;

use axum::routing::{get, put};
use axum::Router;

/// 构造 axum Router。bin 和集成测试都通过它建路由,保证测试覆盖真实路径。
pub fn router() -> Router {
    Router::new()
        .route("/ws", get(ws::ws_handler))
        // host profile 的 CRUD —— 客户端 SSH 配置 UI 走这一组。GET 列表 + POST 创建。
        .route("/api/hosts", get(http::list_hosts).post(http::create_host))
        // PUT 更新 + DELETE 删除(按 id 操作)。
        .route(
            "/api/hosts/:id",
            put(http::update_host).delete(http::delete_host),
        )
}
