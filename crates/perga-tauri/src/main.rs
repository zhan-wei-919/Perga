//! 桌面 bin 入口:复用 `perga_lib::try_run()` 拿到 Result,自己处理错误。
//!
//! 真正的 Tauri builder / setup / commands 都在 `lib.rs` —— 这样 mobile
//! cdylib 入口(`perga_lib::run`,被 `#[tauri::mobile_entry_point]` 标注)
//! 和桌面 bin 共用同一份业务逻辑;`try_run` 把 `Result` 暴露给 caller,
//! desktop 选显式 propagate,mobile wrapper 选 abort。

fn main() {
    if let Err(e) = perga_lib::try_run() {
        eprintln!("perga: fatal: {e}");
        std::process::exit(1);
    }
}
