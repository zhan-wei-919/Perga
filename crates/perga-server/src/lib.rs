//! `perga-server`:axum + tokio 把 `TerminalSession` 暴露成 WebSocket 服务。
//!
//! **角色:dev 浏览器迭代用 adapter**。Phase 6 后 production 入口换成 `perga-tauri`
//! 的 IPC,不再依赖本进程;开发期前端仍跑在 `localhost:5173`(Vite),通过
//! `/api/*` proxy 转 7777 用本服务,享受浏览器 devtools 与热重载。
//!
//! 与协议无关的核心(profile CRUD、ClientMessage、session 工厂)在 `perga-core`,
//! 由本 crate 与 `perga-tauri` 共享。本 crate 只做 axum / WS 缝合 + 默认路径解析。
//!
//! tokio runtime 是 server 专属的 side-pool;PTY / engine / session 全部
//! 仍跑在 sync 线程,只在 [`bridge`] 这一处缝合(CLAUDE.md §运行时模型)。

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
        // host profile 的 CRUD —— 前端 SSH 配置 UI 走这一组。GET 列表 + POST 创建。
        .route("/api/hosts", get(http::list_hosts).post(http::create_host))
        // PUT 更新 + DELETE 删除(按 id 操作)。
        .route(
            "/api/hosts/:id",
            put(http::update_host).delete(http::delete_host),
        )
}
