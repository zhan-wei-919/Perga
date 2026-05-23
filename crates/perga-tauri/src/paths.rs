//! 在 Tauri 沙箱目录下解析 perga-core 需要的配置 / known_hosts 路径。
//!
//! Linux 桌面 → `~/.local/share/io.perga.app/{hosts.toml,known_hosts}`。
//! Android / iOS → 各自 app sandbox 下的 app_data_dir。和 `~/.perga` 故意不
//! 重叠 —— dev 浏览器形态走 perga-server,数据在 `~/.perga`;打包形态走
//! Tauri,数据在 app_data_dir。两份配置 by design,dev 不污染 prod。

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

/// 解析两条核心数据路径。`app_data_dir` 不存在时由本函数 create_dir_all。
pub fn resolve(app: &AppHandle) -> Result<ResolvedPaths, PathError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| PathError::Resolve(format!("app_data_dir: {e}")))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| PathError::Resolve(format!("create_dir_all {}: {e}", dir.display())))?;
    Ok(ResolvedPaths {
        profiles_path: dir.join("hosts.toml"),
        known_hosts_path: dir.join("known_hosts"),
    })
}

#[derive(Debug, Clone)]
pub struct ResolvedPaths {
    pub profiles_path: PathBuf,
    pub known_hosts_path: PathBuf,
}

#[derive(Debug, thiserror::Error)]
pub enum PathError {
    #[error("resolve app data dir: {0}")]
    Resolve(String),
}
