//! REST 端点:`/api/hosts` + `/api/hosts/:id` 的增删改查。
//!
//! 前端 CRUD UI 通过这些端点操作 `~/.perga/hosts.toml`(写文件 + chmod 0600
//! 由 [`crate::profiles`] 负责),用户不直接接触文件系统。
//!
//! 错误分类:
//! - 404:profile id 不存在(`GET /:id` / `PUT /:id` / `DELETE /:id`)。
//! - 409:create 时 id 已存在(`POST /api/hosts`)。
//! - 422:字段校验失败(空 user / host / 0 端口 / password 为空但 auth=password)。
//! - 500:IO / toml 解析等运行时错误,带可读 message。

use axum::extract::Path;
use axum::http::StatusCode;
use axum::Json;

use crate::profiles::{
    create_profile, delete_profile, load_profiles, update_profile, HostProfile, HostProfileSummary,
    ProfileError,
};

/// `GET /api/hosts` —— 列出所有 host profile 的摘要(不含密码)。
pub async fn list_hosts() -> Result<Json<Vec<HostProfileSummary>>, (StatusCode, String)> {
    let profiles = load_profiles().map_err(profile_error_to_response)?;
    let summaries: Vec<HostProfileSummary> = profiles.iter().map(Into::into).collect();
    Ok(Json(summaries))
}

/// `POST /api/hosts` —— 创建一个新 host profile。
///
/// body 是完整的 [`HostProfile`](含 auth 细节;`password` 字段在 `auth =
/// { type = "password", ... }` 时由前端表单填入)。
///
/// 成功 → 200 + 创建后的 summary。
pub async fn create_host(
    Json(profile): Json<HostProfile>,
) -> Result<Json<HostProfileSummary>, (StatusCode, String)> {
    let created = create_profile(profile).map_err(profile_error_to_response)?;
    Ok(Json(HostProfileSummary::from(&created)))
}

/// `PUT /api/hosts/:id` —— 更新已有 host profile。
///
/// `:id` 是 URL path 里的稳定标识;body 里的 `id` 必须与之一致(profile id
/// 不允许通过 PUT 改名,删一个建一个更直观)。
pub async fn update_host(
    Path(id): Path<String>,
    Json(profile): Json<HostProfile>,
) -> Result<Json<HostProfileSummary>, (StatusCode, String)> {
    let updated = update_profile(&id, profile).map_err(profile_error_to_response)?;
    Ok(Json(HostProfileSummary::from(&updated)))
}

/// `DELETE /api/hosts/:id` —— 删除一个 host profile。
///
/// 成功 → 204 No Content。失败 → 404 / 500 with message。
pub async fn delete_host(Path(id): Path<String>) -> Result<StatusCode, (StatusCode, String)> {
    delete_profile(&id).map_err(profile_error_to_response)?;
    Ok(StatusCode::NO_CONTENT)
}

/// `ProfileError` → HTTP status + body 字符串。把领域错误的语义直接映射到
/// 标准 HTTP 错误类别,前端可以靠 status code 做分流。
fn profile_error_to_response(e: ProfileError) -> (StatusCode, String) {
    let status = match &e {
        ProfileError::NotFound(_) => StatusCode::NOT_FOUND,
        ProfileError::Conflict(_) => StatusCode::CONFLICT,
        ProfileError::Validation(_) => StatusCode::UNPROCESSABLE_ENTITY,
        ProfileError::Io(_) | ProfileError::Parse(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (status, format!("{e}"))
}
