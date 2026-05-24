# Perga TODO — 延后工作

记录**有意延后**的工作:打了 stopgap 的实现、留下的已知限制、绑定某个未来阶段的后续项。用法见 [`CLAUDE.md`](CLAUDE.md) 的「延后工作:TODO.md」一节。

这里不是 phase 规划(方向性设计见 `docs/`),只放「当前代码里明知不完整、将来要回来补」的具体条目。做完一条就删一条,git 历史保留痕迹。

---

## OSC 133 over SSH(SSH session 无失败命令红条)

**现状**:Phase 3 的 OSC 133 shell 集成只在本地 PTY 路径自动注入(见
`crates/pty/src/shell_inject.rs`),SSH backend 不动远端 shell 配置。

**已知偏差**:SSH session 内跑命令,客户端不会给失败命令的输入行打红条 ——
失败标记功能只在本地 shell 可用。普通滚动 / 选中复制 / scrollback 等都
不受影响。

**触发条件**:用户实际用 SSH 跑长命令,想要和本地一样的失败可视化。

**要做**:两种思路:
- a) 远端用户手动 `source ~/.perga/shell/perga-{bash,zsh}.sh`(类似 iTerm2
     的 shell 集成手动步骤);
- b) Perga 在 SSH session 启动后通过 channel 注入 setup 命令 —— 但会污染
     用户 shell 历史,需要谨慎设计。

**涉及**:`crates/ssh/src/session.rs`(注入步骤)、`scripts/perga-{bash,zsh}.sh`
(远端可用版本)。

---

## SSH auth 扩展(key file / keyboard-interactive)

**现状**:Phase 5 v1 / v1.5 实现了 `agent` + `password` 两种。**未实现**:
- `key_file { path, passphrase: Option<String> }` —— 用户从沙箱外导入私钥文件,
  passphrase 保护的需要密码框。平板上没有 ssh-agent 而又不愿用 password 时的兜底。
- `keyboard_interactive` —— SSH 协议里的多步交互(2FA / OTP),sshd 默认会
  把密码请求路由到这个方法。russh 提供
  `authenticate_keyboard_interactive_{start,respond}`。

**触发条件**:
- 需要导入现有私钥(常见于公司基础设施场景)。
- 服务端禁用 `PasswordAuthentication`,只放 `keyboard-interactive` —— v1.5
  的 password 路径会失败,但实际相同凭据用 keyboard-interactive 可通。
- 服务端要求 2FA / OTP。

**要做**:`AuthSpec` 加 `KeyFile` / `KeyboardInteractive` 变体;
`crates/ssh/src/session.rs::authenticate_*` 拆成 dispatch;后续原生客户端的
profile UI 加文件导入控件和 prompt 响应 UI(后者跨平台 modal 一致性要小心)。

**涉及**:`crates/ssh/`、`crates/perga-server/src/profiles.rs`、
后续 `clients/*` 的 profile UI。

---

## SSH integration test(in-process russh-server)

**现状**:Phase 5 v1 只有 `SshConfig` / `ProfileError` 单元测试,SSH 通路
本身靠手动 `perga-ssh-probe --host x --user y` 验证。无自动化 SSH 集成测试。

**触发条件**:russh 升级 / TOFU 逻辑大改 / shuttle_loop 重写时回归风险增大。

**要做**:用 `russh::server` 在测试进程内起一个 ephemeral SSH server(预置
host key + agent stub),`SshSession::spawn` 连过去跑一条 echo,验 round-trip。

**涉及**:`crates/ssh/tests/`(新)。

---

## scrollback 饱和(10000 行)后历史停止增长

**现状**:引擎用 alacritty `history_size()` 的增量算「本帧滚出多少行」
(`scroll_total` / `pending_scrolled`)。scrollback 上限是 `Config::default()`
的 10000 行;一旦 `history_size()` 饱和在 10000,旧行被驱逐、新行进入,占用数
不变 → 增量恒 0。于是 `take_scrolled_rows` 不再产出行,客户端 history 停在 1 万
行不再增长,`command_end.line` 也开始漂移。

**已知偏差**:只影响单次会话滚动超过 10000 行的情况。客户端 `HISTORY_MAX` 也应是
10000 —— 即便后端供得上客户端也只留最近 1 万行;真正丢的是「曾滚过但因总量超
1 万被两端都丢弃」的中段历史。

**触发条件**:实测有人滚出 >10000 行、且需要回看更早历史时。根治要引擎换一个
不依赖 `history_size` 增量的滚动计数(如直接数 viewport 滚动事件)。

**涉及**:`crates/terminal-engine/src/engine.rs`(`advance_alacritty`、
`take_scrolled_rows`)。
