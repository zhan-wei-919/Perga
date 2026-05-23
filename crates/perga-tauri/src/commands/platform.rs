//! `get_platform_info`:让前端判断本进程跑在桌面还是移动端。
//!
//! 桌面 vs 移动端的分类直接看 `std::env::consts::OS`,**不**做 form factor
//! 进一步细分(桌面 Linux 上的小屏笔记本仍然是 desktop;Android 平板被分到
//! mobile 即可)。前端基于 `kind` 决定 + 按钮行为 / 首次启动引导。

use serde::Serialize;

/// 平台信息 payload。`kind` 给前端业务逻辑走分支;`os` 仅诊断 / 日志用。
#[derive(Debug, Clone, Serialize)]
pub struct PlatformInfo {
    pub kind: PlatformKind,
    pub os: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PlatformKind {
    Desktop,
    Mobile,
}

#[tauri::command]
pub fn get_platform_info() -> PlatformInfo {
    let os = std::env::consts::OS;
    let kind = match os {
        "android" | "ios" => PlatformKind::Mobile,
        _ => PlatformKind::Desktop,
    };
    PlatformInfo { kind, os }
}
