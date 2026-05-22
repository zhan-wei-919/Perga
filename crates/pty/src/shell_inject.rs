//! Shell 集成自动注入。
//!
//! Phase 3 的 OSC 133 命令块依赖 shell 主动发标记序列,原本要求用户手动
//! `source scripts/perga-{bash,zsh}.sh`。把这一步甩给用户不是终端该有的
//! UX —— VS Code / iTerm2 / WezTerm 都在 spawn shell 时自动注入集成。本
//! 模块做同样的事:spawn 之前改写 `PtyConfig`,让 bash / zsh 无感加载集成。
//!
//! 注入是**渐进增强**。识别 shell 失败(非 bash / zsh)、或写集成文件失败
//! (磁盘满 / 无 HOME / 权限),都退化到「不注入」—— spawn 出来的还是一个
//! 正常 shell,只是没有命令块。这条降级路径就是 Phase 3 之前的正常行为,
//! 有测试、被支持,不是在掩盖 bug,所以这里**可以**容错。
//!
//! 注:本模块负责 spawn 端的「注入」;OSC 133 字节流的**解析**在
//! `terminal-engine` 的 `shell_integration` 模块,两者职责不同,不要混。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::config::PtyConfig;

/// OSC 133 集成脚本,编译期嵌进二进制 —— 运行时不依赖仓库 / 安装布局。
const BASH_INTEGRATION: &str = include_str!("../../../scripts/perga-bash.sh");
const ZSH_INTEGRATION: &str = include_str!("../../../scripts/perga-zsh.sh");

/// bash rcfile 前导:`bash --rcfile` 用本文件顶替 `~/.bashrc`,所以先把用户
/// 真实配置转源回来。集成内容拼在这之后 —— 它要包住用户最终的 PS1。
const BASH_RCFILE_PREAMBLE: &str = "\
# Perga 自动注入的 bash rcfile —— 请勿手改,每次 spawn shell 都会覆盖本文件。
#
# `bash --rcfile <本文件>` 会用它顶替 ~/.bashrc,所以先把用户真实
# ~/.bashrc 转源回来,再挂 Perga 的 OSC 133 集成 —— 集成必须排在用户
# 配置之后,才能正确包住用户最终的 PS1。
if [ -f \"$HOME/.bashrc\" ]; then
    . \"$HOME/.bashrc\"
fi
";

/// 注入到 Perga ZDOTDIR 的 `.zshenv`。在用户原始 ZDOTDIR 下转源用户真实
/// `.zshenv`,记下它跑完后的最终 ZDOTDIR,再把 ZDOTDIR 拉回 Perga 目录 ——
/// 这样即便用户在 `.zshenv` 里 `export ZDOTDIR`,zsh 仍会读到 Perga 的 `.zshrc`。
const ZSH_ZSHENV: &str = "\
# Perga 自动注入的 .zshenv —— 请勿手改,每次 spawn shell 都会覆盖本文件。
#
# ZDOTDIR 被指向 Perga 目录以挂载 shell 集成。本文件:
#   1. 把 ZDOTDIR 临时设回用户原值,让用户 .zshenv 在正确的 ZDOTDIR 下跑;
#   2. 转源用户真实 .zshenv —— 它可能再 export ZDOTDIR(常见 bootstrap 写法);
#   3. 把用户 .zshenv 跑完后的最终 ZDOTDIR 记进 PERGA_USER_ZDOTDIR,供注入的
#      .zshrc 还原 + 转源;
#   4. 把 ZDOTDIR 拉回 Perga 目录 —— zsh 接下来才会读到 Perga 注入的 .zshrc。
__perga_inject_zdotdir=$ZDOTDIR
if [[ -n ${PERGA_USER_ZDOTDIR:-} ]]; then
    ZDOTDIR=$PERGA_USER_ZDOTDIR
else
    unset ZDOTDIR
fi
[[ -f ${ZDOTDIR:-$HOME}/.zshenv ]] && source ${ZDOTDIR:-$HOME}/.zshenv
if [[ -n ${ZDOTDIR:-} ]]; then
    export PERGA_USER_ZDOTDIR=$ZDOTDIR
else
    unset PERGA_USER_ZDOTDIR
fi
export ZDOTDIR=$__perga_inject_zdotdir
unset __perga_inject_zdotdir
";

/// 注入到 Perga ZDOTDIR 的 `.zshrc` 前导:还原 ZDOTDIR 到用户原值、转源用户
/// 真实 `.zshrc`。集成内容拼在这之后 —— 它要包住用户最终的 PROMPT。
const ZSH_ZSHRC_PREAMBLE: &str = "\
# Perga 自动注入的 .zshrc —— 请勿手改,每次 spawn shell 都会覆盖本文件。
#
# 把 ZDOTDIR 还原成用户原值,转源用户真实 .zshrc,再挂 OSC 133 集成。
__perga_user_zdotdir=${PERGA_USER_ZDOTDIR:-$HOME}
if [[ -n ${PERGA_USER_ZDOTDIR:-} ]]; then
    export ZDOTDIR=$PERGA_USER_ZDOTDIR
else
    unset ZDOTDIR
fi
[[ -f $__perga_user_zdotdir/.zshrc ]] && source $__perga_user_zdotdir/.zshrc
unset __perga_user_zdotdir PERGA_USER_ZDOTDIR
";

/// 有 OSC 133 集成脚本的 shell。其它 shell 不注入,降级到纯终端。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShellKind {
    Bash,
    Zsh,
    Other,
}

/// 由可执行文件名识别 shell 种类。只认精确文件名 —— `$SHELL` 已在
/// `default_shell()` 边界校验过是绝对路径,这里只取末段。
fn shell_kind(program: &Path) -> ShellKind {
    match program.file_name().and_then(|n| n.to_str()) {
        Some("bash") => ShellKind::Bash,
        Some("zsh") => ShellKind::Zsh,
        _ => ShellKind::Other,
    }
}

/// 改写 `cfg`,让 spawn 出来的 shell 自动加载 Perga 的 OSC 133 集成。
///
/// best-effort:注入失败时记结构化 warn 并保持 `cfg` 原样,调用方拿到的
/// 仍是一份可正常 spawn 的 config(降级到纯终端,见模块文档)。
pub fn inject_shell_integration(cfg: &mut PtyConfig) {
    // 没有集成脚本的 shell(fish / pwsh / sh ...)是预期内的,不是错误。
    if shell_kind(&cfg.program) == ShellKind::Other {
        return;
    }
    let Some(dir) = perga_shell_dir() else {
        tracing::warn!("pty.shell_integration.no_home");
        return;
    };
    if let Err(error) = inject_in(cfg, &dir) {
        tracing::warn!(
            shell = %cfg.program.display(),
            error = %error,
            "pty.shell_integration.inject_failed"
        );
    }
}

/// `~/.perga/shell` —— 集成文件落地目录。HOME 缺失返回 None。
fn perga_shell_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".perga").join("shell"))
}

/// 把集成文件写到 `dir`,并据 shell 种类改写 `cfg`。`dir` 可注入以便测试。
fn inject_in(cfg: &mut PtyConfig, dir: &Path) -> io::Result<()> {
    match shell_kind(&cfg.program) {
        ShellKind::Bash => inject_bash(cfg, dir),
        ShellKind::Zsh => inject_zsh(cfg, dir),
        ShellKind::Other => Ok(()),
    }
}

/// bash:写 rcfile,`--rcfile` 让 bash 用它替代 `~/.bashrc`。
///
/// `--rcfile` 只对交互式非登录 shell 生效;Perga spawn 的正是这种(不带
/// `-l`),所以无需额外参数。
fn inject_bash(cfg: &mut PtyConfig, dir: &Path) -> io::Result<()> {
    let rcfile = dir.join("bash-rcfile");
    write_atomic(&rcfile, &render_bash_rcfile())?;
    cfg.args.push("--rcfile".to_string());
    cfg.args.push(rcfile.to_string_lossy().into_owned());
    Ok(())
}

/// zsh:写一个 Perga ZDOTDIR(`.zshenv` + `.zshrc`),用 `ZDOTDIR` 环境变量
/// 把 zsh 的启动文件查找重定向过来。
fn inject_zsh(cfg: &mut PtyConfig, dir: &Path) -> io::Result<()> {
    let zdotdir = dir.join("zsh");
    write_atomic(&zdotdir.join(".zshenv"), ZSH_ZSHENV)?;
    write_atomic(&zdotdir.join(".zshrc"), &render_zsh_zshrc())?;

    // 注入的 .zshenv / .zshrc 要转源用户配置、再还原 ZDOTDIR —— 得知道用户
    // 的原值。ZDOTDIR 未设置时不传,脚本侧回退 $HOME。
    if let Some(user_zdotdir) = std::env::var_os("ZDOTDIR") {
        cfg.env.push((
            "PERGA_USER_ZDOTDIR".to_string(),
            user_zdotdir.to_string_lossy().into_owned(),
        ));
    }
    cfg.env.push((
        "ZDOTDIR".to_string(),
        zdotdir.to_string_lossy().into_owned(),
    ));
    Ok(())
}

fn render_bash_rcfile() -> String {
    format!("{BASH_RCFILE_PREAMBLE}\n{BASH_INTEGRATION}")
}

fn render_zsh_zshrc() -> String {
    format!("{ZSH_ZSHRC_PREAMBLE}\n{ZSH_INTEGRATION}")
}

/// 原子写:写同目录临时文件,再 `rename` 到目标。
///
/// server 会并发 spawn 多条 WS,多个线程可能同时写同一个集成文件;直接
/// `fs::write` 会先 truncate,正在启动的 shell 可能读到半截内容。`rename`
/// 在同一目录内是原子的 —— shell 要么读到旧的完整文件,要么读到新的完整
/// 文件,绝不会读到截断态。
fn write_atomic(path: &Path, content: &str) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "集成文件路径缺少父目录"))?;
    fs::create_dir_all(parent)?;

    // tmp 名带 pid + 进程内单调序号,保证跨进程、跨线程都唯一。
    // ORDERING: 仅为生成唯一文件名,无跨线程数据依赖,Relaxed 足够。
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let tmp = parent.join(format!(
        ".perga-tmp.{}.{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    fs::write(&tmp, content)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::PtySize;

    fn cfg_for(program: &str) -> PtyConfig {
        PtyConfig::new(PathBuf::from(program), PtySize::new(24, 80))
    }

    #[test]
    fn shell_kind_recognizes_bash_and_zsh() {
        assert_eq!(shell_kind(Path::new("/bin/bash")), ShellKind::Bash);
        assert_eq!(shell_kind(Path::new("/usr/bin/zsh")), ShellKind::Zsh);
        assert_eq!(shell_kind(Path::new("bash")), ShellKind::Bash);
    }

    #[test]
    fn shell_kind_other_for_unsupported() {
        assert_eq!(shell_kind(Path::new("/usr/bin/fish")), ShellKind::Other);
        assert_eq!(shell_kind(Path::new("/bin/sh")), ShellKind::Other);
    }

    #[test]
    fn bash_rcfile_sources_user_config_before_integration() {
        let rc = render_bash_rcfile();
        let bashrc_at = rc.find(".bashrc").expect("应转源 ~/.bashrc");
        let integration_at = rc
            .find("__PERGA_OSC133_LOADED")
            .expect("应嵌入 OSC 133 集成");
        // 集成必须排在转源用户配置之后,才能包住用户最终 PS1。
        assert!(bashrc_at < integration_at);
    }

    #[test]
    fn zsh_zshrc_sources_user_config_before_integration() {
        let rc = render_zsh_zshrc();
        assert!(rc.contains("ZDOTDIR"));
        let user_at = rc.find(".zshrc").expect("应转源用户 .zshrc");
        let integration_at = rc
            .find("__PERGA_OSC133_LOADED")
            .expect("应嵌入 OSC 133 集成");
        assert!(user_at < integration_at);
    }

    #[test]
    fn inject_bash_writes_rcfile_and_sets_args() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut cfg = cfg_for("/bin/bash");
        inject_in(&mut cfg, dir.path()).expect("inject");

        assert_eq!(cfg.args.first().map(String::as_str), Some("--rcfile"));
        let rcfile = Path::new(cfg.args.get(1).expect("rcfile 路径"));
        assert!(rcfile.exists());
        let content = fs::read_to_string(rcfile).expect("read rcfile");
        assert!(content.contains("__PERGA_OSC133_LOADED"));
        assert!(content.contains(".bashrc"));
    }

    #[test]
    fn inject_zsh_writes_zdotdir_and_sets_env() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut cfg = cfg_for("/usr/bin/zsh");
        inject_in(&mut cfg, dir.path()).expect("inject");

        let zdotdir = cfg
            .env
            .iter()
            .find(|(k, _)| k == "ZDOTDIR")
            .map(|(_, v)| v.clone())
            .expect("应设 ZDOTDIR");
        let zdotdir = Path::new(&zdotdir);
        assert!(zdotdir.join(".zshenv").exists());
        assert!(zdotdir.join(".zshrc").exists());
    }

    #[test]
    fn inject_leaves_unsupported_shell_untouched() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut cfg = cfg_for("/usr/bin/fish");
        inject_in(&mut cfg, dir.path()).expect("inject");
        assert!(cfg.args.is_empty());
        assert!(cfg.env.is_empty());
    }

    #[test]
    fn write_atomic_creates_dirs_and_overwrites() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("nested").join("file");
        write_atomic(&path, "first").expect("write 1");
        write_atomic(&path, "second").expect("write 2");
        assert_eq!(fs::read_to_string(&path).expect("read"), "second");
    }

    #[test]
    fn zsh_zshenv_repins_zdotdir_when_user_redirects_it() {
        // 用户在 .zshenv 里 export ZDOTDIR 时,Perga 注入的 .zshenv 跑完后
        // 必须把 ZDOTDIR 拉回 Perga 注入目录,否则 zsh 会去用户目录读
        // .zshrc,Perga 集成不被加载、命令块消失。
        //
        // .zshenv 的 ZDOTDIR 存取是 POSIX/bash 兼容子集,用 bash 跑它来验证
        // 控制流(不依赖 zsh runtime —— 本机未必装了 zsh)。
        let home = tempfile::tempdir().expect("home");
        let perga = tempfile::tempdir().expect("perga");
        let redirected = home.path().join("user-zdotdir");
        fs::write(
            home.path().join(".zshenv"),
            format!("export ZDOTDIR={}\n", redirected.display()),
        )
        .expect("write user .zshenv");
        fs::write(perga.path().join(".zshenv"), ZSH_ZSHENV).expect("write perga .zshenv");

        let body = format!(
            "source \"{}/.zshenv\"\nprintf 'RESULT=%s\\n' \"$ZDOTDIR\"",
            perga.path().display()
        );
        let out = std::process::Command::new("bash")
            .args(["--norc", "-c", &body])
            .env("HOME", home.path())
            .env("ZDOTDIR", perga.path())
            .env_remove("PERGA_USER_ZDOTDIR")
            .stderr(std::process::Stdio::null())
            .output()
            .expect("run bash");
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            stdout.contains(&format!("RESULT={}", perga.path().display())),
            ".zshenv 跑完后 ZDOTDIR 应仍指向 Perga 注入目录,实际:{stdout}"
        );
    }

    #[test]
    fn bash_precmd_preserves_exit_status_for_later_hooks() {
        // __perga_precmd prepend 在用户 PROMPT_COMMAND hook 前面,必须把命令
        // 真实的 $? 透传下去,否则 starship / direnv 等后续 hook 看到的全是 0,
        // 失败命令会被显示成成功。
        let dir = tempfile::tempdir().expect("tempdir");
        let script = dir.path().join("perga-bash.sh");
        fs::write(&script, BASH_INTEGRATION).expect("write script");

        // 集成脚本有 `case "$-" in *i*` 交互守卫,故 `-i`。
        let body = format!(
            "source \"{}\"\nfalse\n__perga_precmd >/dev/null 2>&1\nexit $?",
            script.display()
        );
        let status = std::process::Command::new("bash")
            .args(["--norc", "-i", "-c", &body])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("run bash");
        assert_eq!(
            status.code(),
            Some(1),
            "__perga_precmd 应把调用时的 $?(1)透传给后续 hook"
        );
    }

    #[test]
    fn zsh_precmd_preserves_exit_status_for_later_hooks() {
        if !zsh_available() {
            eprintln!("skip zsh_precmd_preserves_exit_status_for_later_hooks: 本机无 zsh");
            return;
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let script = dir.path().join("perga-zsh.sh");
        fs::write(&script, ZSH_INTEGRATION).expect("write script");

        let body = format!(
            "source \"{}\"\nfalse\n__perga_precmd >/dev/null 2>&1\nexit $?",
            script.display()
        );
        let status = std::process::Command::new("zsh")
            .args(["-i", "-c", &body])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("run zsh");
        assert_eq!(status.code(), Some(1), "__perga_precmd 应透传 $?");
    }

    fn zsh_available() -> bool {
        std::process::Command::new("zsh")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}
