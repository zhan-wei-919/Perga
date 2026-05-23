//! Host profile CRUD command。对应 perga-server 的 `/api/hosts` REST 端点,
//! 但走 Tauri invoke 不依赖 HTTP。
//!
//! 路径由 setup 阶段注入到 `AppState`(`app_data_dir().join("hosts.toml")`),
//! command 直接消费 — 与 perga-server 走 `$HOME/.perga` 故意分裂(dev 不污染 prod)。
//!
//! 错误返回 `String`(Tauri 2 标准做法)。前端按错误前缀分类:
//! `"not_found:"` / `"conflict:"` / `"validation:"` / `"io:"`。前端 ProfileApiError
//! 把它们映射回原来的 HTTP 404/409/422/500 等价语义。

use perga_core::profiles::{
    create_profile_at, delete_profile_at, load_profiles_from, update_profile_at, HostProfile,
    HostProfileSummary, ProfileError,
};
use tauri::State;

use crate::AppState;

#[tauri::command]
pub async fn list_hosts(state: State<'_, AppState>) -> Result<Vec<HostProfileSummary>, String> {
    let path = state.profiles_path.clone();
    tokio::task::spawn_blocking(move || {
        let profiles = load_profiles_from(&path).map_err(profile_error_to_string)?;
        Ok::<Vec<HostProfileSummary>, String>(profiles.iter().map(Into::into).collect())
    })
    .await
    .map_err(|e| format!("io:spawn_blocking joined with error: {e}"))?
}

#[tauri::command]
pub async fn create_host(
    profile: HostProfile,
    state: State<'_, AppState>,
) -> Result<HostProfileSummary, String> {
    let path = state.profiles_path.clone();
    tokio::task::spawn_blocking(move || {
        let created = create_profile_at(&path, profile).map_err(profile_error_to_string)?;
        Ok::<HostProfileSummary, String>(HostProfileSummary::from(&created))
    })
    .await
    .map_err(|e| format!("io:spawn_blocking joined with error: {e}"))?
}

#[tauri::command]
pub async fn update_host(
    id: String,
    profile: HostProfile,
    state: State<'_, AppState>,
) -> Result<HostProfileSummary, String> {
    let path = state.profiles_path.clone();
    tokio::task::spawn_blocking(move || {
        let updated = update_profile_at(&path, &id, profile).map_err(profile_error_to_string)?;
        Ok::<HostProfileSummary, String>(HostProfileSummary::from(&updated))
    })
    .await
    .map_err(|e| format!("io:spawn_blocking joined with error: {e}"))?
}

#[tauri::command]
pub async fn delete_host(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let path = state.profiles_path.clone();
    tokio::task::spawn_blocking(move || {
        delete_profile_at(&path, &id).map_err(profile_error_to_string)
    })
    .await
    .map_err(|e| format!("io:spawn_blocking joined with error: {e}"))?
}

/// `ProfileError` → 带语义前缀的字符串。前端按前缀 split 映射到 HTTP 等价。
fn profile_error_to_string(e: ProfileError) -> String {
    match &e {
        ProfileError::NotFound(_) => format!("not_found:{e}"),
        ProfileError::Conflict(_) => format!("conflict:{e}"),
        ProfileError::Validation(_) => format!("validation:{e}"),
        ProfileError::Io(_) | ProfileError::Parse(_) => format!("io:{e}"),
    }
}
