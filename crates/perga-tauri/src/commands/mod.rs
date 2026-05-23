//! Tauri command 集合。每个子模块对应一组职责;`crate::main` 在
//! `tauri::generate_handler!` 处统一注册。

pub mod platform;
pub mod profiles;
pub mod session;
