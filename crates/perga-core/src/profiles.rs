//! Host profile 存储:`hosts.toml` 的读取 + 写入 + 翻译。
//!
//! **用户**通过客户端设置面板的 CRUD UI 增删改 host,**不直接接触文件** ──
//! `hosts.toml` 仅是后端的持久化实现细节。写入走原子写(临时文件 + rename),
//! Unix 上文件权限 0600(只本机当前用户可读,密码不外漏)。
//!
//! 不缓存:每次操作都读盘 → 改 → 原子写。文件小,IO 开销忽略;换来「外部
//! 编辑(虽然不推荐)与 UI 操作不冲突」的简单语义。
//!
//! schema(默认 `~/.perga/hosts.toml`,沙盒客户端可传入 app data 路径):
//!
//! ```toml
//! [[hosts]]
//! id    = "prod-db"                                       # 唯一 id
//! name  = "Production DB"                                 # UI 显示
//! host  = "db.prod.example.com"
//! port  = 22
//! user  = "ubuntu"
//! auth  = { type = "agent" }                              # 或:
//! # auth = { type = "password", password = "secret" }     # 明文存盘 + 0600
//! ```
//!
//! `auth` 用 tagged enum:`agent` 走系统 ssh-agent(桌面);`password` 明文
//! 由客户端表单填,适用桌面 + 平板(平板没有 ssh-agent)。后续若加 `key_file`
//! / `keyboard_interactive`,加一个 variant 不破坏现有 schema。
//!
//! # 路径注入
//!
//! 所有 IO 主接口都接受 `&Path` 参数(`*_at` 系列):perga-server 走
//! `default_profiles_path()` 解析 `$HOME/.perga/hosts.toml`,原生客户端 wrapper 可走
//! 平台 app data 目录。`load_profiles()` / `create_profile()` 等
//! 无参 wrapper 是为 dev 桌面侧的简便起见保留,内部仍是调 `*_at`。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 顶层 toml 结构。`hosts` 是 array of tables。read 用 `HostsFile`,
/// write 用 [`HostsFileOut`],分两个 struct 因为 Serialize 路径需要借引用、
/// Deserialize 需要拥有所有权。
#[derive(Debug, Deserialize)]
struct HostsFile {
    #[serde(default)]
    hosts: Vec<HostProfile>,
}

#[derive(Debug, Serialize)]
struct HostsFileOut<'a> {
    hosts: &'a [HostProfile],
}

/// 单条 host 配置。完整字段(**包含 auth 细节**,密码明文);仅本 crate 内
/// 消费用于翻译成 [`ssh::SshConfig`],不直接对客户端暴露的 list 路径泄漏密码。
/// 写回 toml 时也用这个结构。
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct HostProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub user: String,
    pub auth: AuthSpec,
}

/// 认证方式。tagged enum:
/// - `{ type = "agent" }`:系统 ssh-agent(桌面 only)。
/// - `{ type = "password", password = "..." }`:明文密码(桌面 + 平板)。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AuthSpec {
    Agent,
    Password { password: String },
}

/// 给客户端的 list 视图 ── **不**返回密码明文,只返回「使用什么 auth 方式」
/// 给 UI 选择性显示。
#[derive(Debug, Clone, Serialize)]
pub struct HostProfileSummary {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    /// `"agent"` 或 `"password"`。客户端只用来做 icon / label,不携带密码本身。
    pub auth_kind: &'static str,
}

impl From<&HostProfile> for HostProfileSummary {
    fn from(p: &HostProfile) -> Self {
        Self {
            id: p.id.clone(),
            name: p.name.clone(),
            host: p.host.clone(),
            port: p.port,
            user: p.user.clone(),
            auth_kind: match p.auth {
                AuthSpec::Agent => "agent",
                AuthSpec::Password { .. } => "password",
            },
        }
    }
}

const fn default_port() -> u16 {
    22
}

/// 读默认路径(`$HOME/.perga/hosts.toml`)的 profile。仅 dev 桌面调用。
pub fn load_profiles() -> Result<Vec<HostProfile>, ProfileError> {
    let path = default_profiles_path()?;
    load_profiles_from(&path)
}

/// 从指定路径读 profile —— **主接口**。perga-server 走 `default_profiles_path()`,
/// 沙盒客户端 wrapper 走平台 app data 目录,测试走 tempfile。
///
/// 文件不存在 → 返回空 Vec(没配 host 是合法状态,不报错)。
/// 文件存在但解析失败 → 返回 Err,让上层暴露具体原因(toml 行号、字段名)。
pub fn load_profiles_from(path: &Path) -> Result<Vec<HostProfile>, ProfileError> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(ProfileError::Io(format!("read {}: {e}", path.display()))),
    };
    let file: HostsFile = toml::from_str(&text)
        .map_err(|e| ProfileError::Parse(format!("{}: {e}", path.display())))?;

    // 重复 id 校验 —— 通过 id 引用 host 必须唯一。
    let mut seen = std::collections::HashSet::new();
    for h in &file.hosts {
        if !seen.insert(h.id.as_str()) {
            return Err(ProfileError::Parse(format!(
                "{}: duplicate host id '{}'",
                path.display(),
                h.id
            )));
        }
    }

    Ok(file.hosts)
}

/// 按 id 找 profile。
pub fn find_profile(profiles: &[HostProfile], id: &str) -> Option<HostProfile> {
    profiles.iter().find(|p| p.id == id).cloned()
}

/// Profile → SSH backend 配置的翻译。`crates/ssh` 不知道 profile 概念,
/// 由 caller 在这里做映射。`known_hosts_path` 由调用方决定:perga-server 传
/// `None`(让 ssh crate 走 `~/.ssh/known_hosts`),沙盒客户端 wrapper 传
/// `Some(app_data_dir.join("known_hosts"))`。
pub fn to_ssh_config(profile: &HostProfile, known_hosts_path: Option<PathBuf>) -> ssh::SshConfig {
    let auth = match &profile.auth {
        AuthSpec::Agent => ssh::Auth::Agent,
        AuthSpec::Password { password } => ssh::Auth::Password {
            password: password.clone(),
        },
    };
    ssh::SshConfig {
        host: profile.host.clone(),
        port: profile.port,
        user: profile.user.clone(),
        auth,
        known_hosts_path,
    }
}

// ───────────────────── CRUD(增删改)─────────────────────

/// 创建一个新 host profile,**追加**写回默认路径。
pub fn create_profile(profile: HostProfile) -> Result<HostProfile, ProfileError> {
    let path = default_profiles_path()?;
    create_profile_at(&path, profile)
}

/// **主接口**:对指定路径执行 create。
pub fn create_profile_at(path: &Path, profile: HostProfile) -> Result<HostProfile, ProfileError> {
    validate_profile(&profile)?;
    let mut existing = load_profiles_from(path)?;
    if existing.iter().any(|p| p.id == profile.id) {
        return Err(ProfileError::Conflict(format!(
            "profile id '{}' already exists",
            profile.id
        )));
    }
    existing.push(profile.clone());
    save_profiles_atomic(&existing, path)?;
    Ok(profile)
}

/// 更新已有 host profile(按 id 匹配)。id 不能变 ── 想"重命名 id"=删一个建一个。
pub fn update_profile(id: &str, updated: HostProfile) -> Result<HostProfile, ProfileError> {
    let path = default_profiles_path()?;
    update_profile_at(&path, id, updated)
}

/// **主接口**:对指定路径执行 update。
pub fn update_profile_at(
    path: &Path,
    id: &str,
    updated: HostProfile,
) -> Result<HostProfile, ProfileError> {
    validate_profile(&updated)?;
    if updated.id != id {
        return Err(ProfileError::Validation(format!(
            "cannot change profile id from '{id}' to '{}' via update; delete + create instead",
            updated.id
        )));
    }
    let mut existing = load_profiles_from(path)?;
    let idx = existing
        .iter()
        .position(|p| p.id == id)
        .ok_or_else(|| ProfileError::NotFound(id.to_string()))?;
    existing[idx] = updated.clone();
    save_profiles_atomic(&existing, path)?;
    Ok(updated)
}

/// 删除一个 host profile。id 不存在返 `NotFound`。
pub fn delete_profile(id: &str) -> Result<(), ProfileError> {
    let path = default_profiles_path()?;
    delete_profile_at(&path, id)
}

/// **主接口**:对指定路径执行 delete。
pub fn delete_profile_at(path: &Path, id: &str) -> Result<(), ProfileError> {
    let mut existing = load_profiles_from(path)?;
    let idx = existing
        .iter()
        .position(|p| p.id == id)
        .ok_or_else(|| ProfileError::NotFound(id.to_string()))?;
    existing.remove(idx);
    save_profiles_atomic(&existing, path)?;
    Ok(())
}

/// 原子写 `hosts.toml`:临时文件 → set 0600 → rename。
///
/// 参考 `pty/src/shell_inject.rs::write_atomic`。临时文件名带 pid + 进程内单调
/// 序号,挡住并发写截断。`rename` 在同目录下是原子操作,读端不会读到半截。
fn save_profiles_atomic(profiles: &[HostProfile], path: &Path) -> Result<(), ProfileError> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);

    let body = toml::to_string(&HostsFileOut { hosts: profiles })
        .map_err(|e| ProfileError::Io(format!("serialize hosts.toml: {e}")))?;

    let parent = path.parent().ok_or_else(|| {
        ProfileError::Io(format!("hosts.toml path has no parent: {}", path.display()))
    })?;
    std::fs::create_dir_all(parent)
        .map_err(|e| ProfileError::Io(format!("create_dir_all {}: {e}", parent.display())))?;

    let tmp = parent.join(format!(
        ".perga-hosts.tmp.{}.{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&tmp, &body)
        .map_err(|e| ProfileError::Io(format!("write {}: {e}", tmp.display())))?;

    // Unix: 0600(只本机当前用户可读 / 写)。Windows ACL 由 OS 默认处理,
    // 通常已经限制在当前用户。
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        std::fs::set_permissions(&tmp, perms)
            .map_err(|e| ProfileError::Io(format!("chmod 0600 {}: {e}", tmp.display())))?;
    }

    std::fs::rename(&tmp, path).map_err(|e| {
        ProfileError::Io(format!(
            "rename {} -> {}: {e}",
            tmp.display(),
            path.display()
        ))
    })?;
    Ok(())
}

/// 字段层面的基本校验。**不**校验 host 是否可达 / port 是否合法,那些是
/// 连接时的事;这里只挡明显的空 / 越界。
fn validate_profile(p: &HostProfile) -> Result<(), ProfileError> {
    if p.id.trim().is_empty() {
        return Err(ProfileError::Validation("id is empty".into()));
    }
    if p.name.trim().is_empty() {
        return Err(ProfileError::Validation("name is empty".into()));
    }
    if p.host.trim().is_empty() {
        return Err(ProfileError::Validation("host is empty".into()));
    }
    if p.user.trim().is_empty() {
        return Err(ProfileError::Validation("user is empty".into()));
    }
    if p.port == 0 {
        return Err(ProfileError::Validation("port must be > 0".into()));
    }
    if let AuthSpec::Password { password } = &p.auth {
        if password.is_empty() {
            return Err(ProfileError::Validation(
                "password auth requires a non-empty password (leave field blank to use agent instead)".into(),
            ));
        }
    }
    Ok(())
}

/// 默认桌面路径 `$HOME/.perga/hosts.toml`。沙盒客户端 wrapper 可改走平台
/// app data 目录。
fn default_profiles_path() -> Result<PathBuf, ProfileError> {
    let home = std::env::var_os("HOME").ok_or_else(|| {
        ProfileError::Io("$HOME not set; cannot locate ~/.perga/hosts.toml".into())
    })?;
    let mut p = PathBuf::from(home);
    p.push(".perga");
    p.push("hosts.toml");
    Ok(p)
}

#[derive(Debug, thiserror::Error)]
pub enum ProfileError {
    #[error("read profile file: {0}")]
    Io(String),
    #[error("parse profile file: {0}")]
    Parse(String),
    #[error("profile not found: {0}")]
    NotFound(String),
    #[error("profile conflict: {0}")]
    Conflict(String),
    #[error("profile validation failed: {0}")]
    Validation(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_toml(content: &str) -> tempfile::NamedTempFile {
        let mut f = tempfile::NamedTempFile::new().expect("tempfile");
        f.write_all(content.as_bytes()).expect("write");
        f
    }

    #[test]
    fn empty_file_yields_empty_profiles() {
        let f = write_toml("");
        let profiles = load_profiles_from(f.path()).expect("parse empty");
        assert!(profiles.is_empty());
    }

    #[test]
    fn missing_file_yields_empty_profiles() {
        let path = PathBuf::from("/tmp/perga-profiles-missing-aaaaaaa.toml");
        let profiles = load_profiles_from(&path).expect("missing should be Ok");
        assert!(profiles.is_empty());
    }

    #[test]
    fn parses_single_host() {
        let f = write_toml(
            r#"
            [[hosts]]
            id = "prod"
            name = "Production"
            host = "db.example.com"
            user = "ubuntu"
            auth = { type = "agent" }
            "#,
        );
        let profiles = load_profiles_from(f.path()).expect("parse");
        assert_eq!(profiles.len(), 1);
        let p = &profiles[0];
        assert_eq!(p.id, "prod");
        assert_eq!(p.host, "db.example.com");
        assert_eq!(p.port, 22); // 默认
        assert_eq!(p.user, "ubuntu");
        assert!(matches!(p.auth, AuthSpec::Agent));
    }

    #[test]
    fn explicit_port_parsed() {
        let f = write_toml(
            r#"
            [[hosts]]
            id = "alt"
            name = "Alt"
            host = "x.example.com"
            port = 2222
            user = "z"
            auth = { type = "agent" }
            "#,
        );
        let profiles = load_profiles_from(f.path()).expect("parse");
        assert_eq!(profiles[0].port, 2222);
    }

    #[test]
    fn password_auth_parsed() {
        let f = write_toml(
            r#"
            [[hosts]]
            id = "p"
            name = "P"
            host = "h"
            user = "u"
            auth = { type = "password", password = "secret" }
            "#,
        );
        let profiles = load_profiles_from(f.path()).expect("parse password auth");
        match &profiles[0].auth {
            AuthSpec::Password { password } => assert_eq!(password, "secret"),
            other => panic!("expected password auth, got {other:?}"),
        }
    }

    #[test]
    fn unknown_auth_type_errors() {
        let f = write_toml(
            r#"
            [[hosts]]
            id = "p"
            name = "P"
            host = "h"
            user = "u"
            auth = { type = "smartcard" }
            "#,
        );
        let err = load_profiles_from(f.path()).expect_err("should reject unknown auth type");
        assert!(matches!(err, ProfileError::Parse(_)), "got {err:?}");
    }

    #[test]
    fn duplicate_id_errors() {
        let f = write_toml(
            r#"
            [[hosts]]
            id = "dup"
            name = "A"
            host = "a"
            user = "u"
            auth = { type = "agent" }

            [[hosts]]
            id = "dup"
            name = "B"
            host = "b"
            user = "u"
            auth = { type = "agent" }
            "#,
        );
        let err = load_profiles_from(f.path()).expect_err("should reject dup id");
        assert!(matches!(err, ProfileError::Parse(_)), "got {err:?}");
    }

    #[test]
    fn find_profile_returns_match() {
        let p1 = HostProfile {
            id: "a".into(),
            name: "A".into(),
            host: "h1".into(),
            port: 22,
            user: "u".into(),
            auth: AuthSpec::Agent,
        };
        let p2 = HostProfile {
            id: "b".into(),
            name: "B".into(),
            host: "h2".into(),
            port: 22,
            user: "u".into(),
            auth: AuthSpec::Agent,
        };
        let profiles = vec![p1.clone(), p2.clone()];
        // 取 host 字段比对而非整 struct,避免给 HostProfile 加 PartialEq 派生。
        assert_eq!(
            find_profile(&profiles, "b").map(|p| p.host),
            Some("h2".into())
        );
        assert!(find_profile(&profiles, "missing").is_none());
    }

    #[test]
    fn ssh_config_translation_preserves_fields() {
        let profile = HostProfile {
            id: "p".into(),
            name: "P".into(),
            host: "h.example.com".into(),
            port: 2222,
            user: "deploy".into(),
            auth: AuthSpec::Agent,
        };
        let cfg = to_ssh_config(&profile, None);
        assert_eq!(cfg.host, "h.example.com");
        assert_eq!(cfg.port, 2222);
        assert_eq!(cfg.user, "deploy");
        assert!(matches!(cfg.auth, ssh::Auth::Agent));
        assert!(cfg.known_hosts_path.is_none());
    }

    #[test]
    fn ssh_config_translation_password_auth() {
        let profile = HostProfile {
            id: "p".into(),
            name: "P".into(),
            host: "h".into(),
            port: 22,
            user: "u".into(),
            auth: AuthSpec::Password {
                password: "s3cret".into(),
            },
        };
        let cfg = to_ssh_config(&profile, None);
        match cfg.auth {
            ssh::Auth::Password { password } => assert_eq!(password, "s3cret"),
            other => panic!("expected password auth, got {other:?}"),
        }
    }

    #[test]
    fn ssh_config_translation_with_known_hosts_path() {
        let profile = HostProfile {
            id: "p".into(),
            name: "P".into(),
            host: "h".into(),
            port: 22,
            user: "u".into(),
            auth: AuthSpec::Agent,
        };
        let custom = PathBuf::from("/tmp/perga/test/known_hosts");
        let cfg = to_ssh_config(&profile, Some(custom.clone()));
        assert_eq!(cfg.known_hosts_path.as_deref(), Some(custom.as_path()));
    }

    fn sample_profile(id: &str, host: &str) -> HostProfile {
        HostProfile {
            id: id.into(),
            name: format!("name-{id}"),
            host: host.into(),
            port: 22,
            user: "u".into(),
            auth: AuthSpec::Password {
                password: "pw".into(),
            },
        }
    }

    /// Tempfile 落地;`NamedTempFile` 自身已经预创建空文件,我们让原子写
    /// 用同目录 + 不同名的临时文件后 rename 上来。这里给出**目录里的目标
    /// 路径**,而不是 NamedTempFile 自带的那条 — 后者已经存在,我们要从
    /// "不存在 → 创建"的全流程测起。
    fn fresh_path() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("hosts.toml");
        (dir, path)
    }

    #[test]
    fn create_then_list_then_delete() {
        let (_dir, path) = fresh_path();
        create_profile_at(&path, sample_profile("a", "host-a")).expect("create");
        create_profile_at(&path, sample_profile("b", "host-b")).expect("create b");

        let listed = load_profiles_from(&path).expect("list");
        assert_eq!(listed.len(), 2);

        delete_profile_at(&path, "a").expect("delete a");
        let listed = load_profiles_from(&path).expect("list after delete");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "b");
    }

    #[test]
    fn create_duplicate_id_conflicts() {
        let (_dir, path) = fresh_path();
        create_profile_at(&path, sample_profile("a", "x")).expect("create first");
        let err =
            create_profile_at(&path, sample_profile("a", "y")).expect_err("dup id should conflict");
        assert!(matches!(err, ProfileError::Conflict(_)), "got {err:?}");
    }

    #[test]
    fn update_preserves_id_changes_other_fields() {
        let (_dir, path) = fresh_path();
        create_profile_at(&path, sample_profile("a", "old-host")).expect("create");
        let mut updated = sample_profile("a", "new-host");
        updated.user = "newuser".into();
        update_profile_at(&path, "a", updated).expect("update");

        let listed = load_profiles_from(&path).expect("list");
        assert_eq!(listed[0].host, "new-host");
        assert_eq!(listed[0].user, "newuser");
    }

    #[test]
    fn update_rejects_id_rename() {
        let (_dir, path) = fresh_path();
        create_profile_at(&path, sample_profile("a", "x")).expect("create");
        let renamed = sample_profile("b", "x"); // 不同 id
        let err = update_profile_at(&path, "a", renamed).expect_err("id rename should fail");
        assert!(matches!(err, ProfileError::Validation(_)), "got {err:?}");
    }

    #[test]
    fn update_missing_id_is_not_found() {
        let (_dir, path) = fresh_path();
        let err = update_profile_at(&path, "ghost", sample_profile("ghost", "x"))
            .expect_err("missing id");
        assert!(matches!(err, ProfileError::NotFound(_)), "got {err:?}");
    }

    #[test]
    fn delete_missing_id_is_not_found() {
        let (_dir, path) = fresh_path();
        let err = delete_profile_at(&path, "ghost").expect_err("missing id");
        assert!(matches!(err, ProfileError::NotFound(_)), "got {err:?}");
    }

    #[test]
    fn validation_blocks_empty_password() {
        let (_dir, path) = fresh_path();
        let mut p = sample_profile("a", "h");
        p.auth = AuthSpec::Password {
            password: "".into(),
        };
        let err = create_profile_at(&path, p).expect_err("empty password should fail");
        assert!(matches!(err, ProfileError::Validation(_)), "got {err:?}");
    }

    #[test]
    fn validation_blocks_empty_fields() {
        let (_dir, path) = fresh_path();
        let mut p = sample_profile("a", "h");
        p.user = "   ".into(); // whitespace-only
        let err = create_profile_at(&path, p).expect_err("blank user should fail");
        assert!(matches!(err, ProfileError::Validation(_)), "got {err:?}");
    }

    #[cfg(unix)]
    #[test]
    fn saved_file_has_0600_perms() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, path) = fresh_path();
        create_profile_at(&path, sample_profile("a", "h")).expect("create");
        let meta = std::fs::metadata(&path).expect("stat");
        let mode = meta.permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o600,
            "hosts.toml 必须是 0600(密码明文,只本机当前用户可读)"
        );
    }

    #[test]
    fn roundtrip_password_through_toml() {
        let (_dir, path) = fresh_path();
        create_profile_at(&path, sample_profile("a", "h")).expect("create");
        let listed = load_profiles_from(&path).expect("load back");
        match &listed[0].auth {
            AuthSpec::Password { password } => assert_eq!(password, "pw"),
            other => panic!("expected password auth, got {other:?}"),
        }
    }
}
