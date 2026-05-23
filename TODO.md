# Perga TODO — 延后工作

记录**有意延后**的工作:打了 stopgap 的实现、留下的已知限制、绑定某个未来阶段的后续项。用法见 [`CLAUDE.md`](CLAUDE.md) 的「延后工作:TODO.md」一节。

这里不是 phase 规划(阶段计划在 `docs/state-*.md` 快照里),只放「当前代码里明知不完整、将来要回来补」的具体条目。做完一条就删一条,git 历史保留痕迹。

---

## autotest:输入回显阶段仍用静默窗口

**现状**:`web/src/util/autotest.ts` 的**命令执行阶段**用 `command_end` 协议
事件确定性判定结束,`run()` 循环也有确定性单元测试。但**输入回显阶段**(把
命令逐字符打进去、等回显落定)仍用静默窗口启发式。

**已知偏差**:回显阶段不计入耗时统计,只为把「回显」与「命令输出」两段事件
流分开;静默窗口在这里的偏差无害,但仍是启发式。

**触发条件**:若要让回显阶段也确定化。需要后端把 `command_start`(OSC 133 C)
也作为协议事件下发 —— 当前只发 `command_end`。

**涉及**:`web/src/util/autotest.ts`、`crates/terminal-protocol/src/event.rs`。

---

## 后台 tab 的 dispatch 不暂停

**现状**:Phase 2 每个 pane 一条独立 WS。切换 tab 时,后台 tab 的 pane renderer
会卸载(不再渲染),但它的 WS 仍保活、`LeafSession.onEvent` 仍逐事件跑
`store.dispatch`(更新 backing grid + rowGen)。这是有意的简化 —— 让后台 tab 切回
来时画面已是最新,不需要重放。

**已知偏差**:

- 后台 tab 里跑噪声程序(`top` / `tail -f` / `cat` 大文件)会持续消耗主线程的
  dispatch 成本,即便用户看不到那个 pane。
- pane / tab 数量是个位数、且后台一般是空闲 shell 时,这个开销可忽略。

**触发条件**:实测发现「多 tab + 后台噪声程序」拖累前台 pane 时。

**要做**:给隐藏 tab 的 `LeafSession` 暂停 dispatch —— 缓冲事件或只保留最新一帧,
切回该 tab 时再重建 grid。

**涉及**:`web/src/state/workspace.ts`(`LeafSession.onEvent`)、
`web/src/state/session_store.ts`。

---

## 移动端打包 — Android init / signing / 真机

**现状**:**代码层闭口已完成**。`crates/pty` 在 Android/iOS target 整 crate
cfg-gate(`portable-pty` + `libc` 仅桌面);`terminal-session::spawn_local`、
`perga-core::session_factory::{open_local, OpenError::LocalPty}` 跟随 gate;
`perga-tauri::session_open` 的 `None =>` arm 在移动 target 返回
`local_unavailable:` 错误;前端 `createWorkspace` 起步 `tabs: []`,App 层按
platform 决定是 newTab(desktop)还是 setPickerOpen(mobile)。
`perga-tauri` 已拆 `lib.rs::run()` + `[lib] crate-type = ["staticlib","cdylib","rlib"]`,
Android cdylib 加载点就绪。

**剩余偏差**:

- 没跑过 `cargo tauri android init`,Gradle / Xcode 工程文件未生成。
- ring/aws-lc-sys 在 Android target 需要 NDK `aarch64-linux-android-clang` +
  cross-compile 配置,目前 host 上没装 NDK。
- 没有 Android keystore;没有 Apple Developer Program 账号。
- 没在真机 / 模拟器跑过。

**触发条件**:实际要在平板上发版时。

**要做**:

1. **`cargo tauri android init`**:生成 `gen/android` Gradle 项目骨架;`tauri.conf.json`
   补 mobile entry。
2. **NDK 链接配置**:装 Android NDK,配 `~/.cargo/config.toml` 的
   `[target.aarch64-linux-android]` linker / ar / clang;ring / aws-lc-sys 通过
   `CC_aarch64-linux-android` 找到 NDK 工具链。
3. **Android signing**:`keytool` 生成 release keystore,`tauri.conf.json` 的
   `bundle.android.signingConfig` 配上。
4. **iOS path**:`cargo tauri ios init`,Apple Developer 账号 + Xcode signing profile。
5. **真机调试**:`cargo tauri android dev` / `ios dev` 走 USB / 模拟器烟雾测试 ──
   首屏弹 picker → 添加 profile → SSH 进远端 shell。

**涉及**:`crates/perga-tauri/tauri.conf.json`、`~/.cargo/config.toml`(NDK target)。

---

## OSC 133 over SSH(SSH session 无失败命令红条)

**现状**:Phase 3 的 OSC 133 shell 集成只在本地 PTY 路径自动注入(见
`crates/pty/src/shell_inject.rs`),SSH backend 不动远端 shell 配置。

**已知偏差**:SSH session 内跑命令,前端不会给失败命令的输入行打红条 ——
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
`crates/ssh/src/session.rs::authenticate_*` 拆成 dispatch;前端表单加文件
导入控件和 prompt 响应 UI(后者跨平台 modal 一致性要小心)。

**涉及**:`crates/ssh/`、`crates/perga-server/src/profiles.rs`、
`web/src/ui/settings_panel.tsx`、`web/src/state/profiles.ts`。

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
不变 → 增量恒 0。于是 `take_scrolled_rows` 不再产出行,前端 history 停在 1 万
行不再增长,`command_end.line` 也开始漂移。

**已知偏差**:只影响单次会话滚动超过 10000 行的情况。前端 `HISTORY_MAX` 也是
10000 —— 即便后端供得上前端也只留最近 1 万行;真正丢的是「曾滚过但因总量超
1 万被两端都丢弃」的中段历史。

**触发条件**:实测有人滚出 >10000 行、且需要回看更早历史时。根治要引擎换一个
不依赖 `history_size` 增量的滚动计数(如直接数 viewport 滚动事件)。

**涉及**:`crates/terminal-engine/src/engine.rs`(`advance_alacritty`、
`take_scrolled_rows`)。

---

## Tauri Linux bundle 美化 / 跨桌面 OS / 代码签名

**现状**:Phase 6 v1 完成 Tauri 集成,Linux 桌面 `cargo build -p perga-tauri`
通过、`cargo tauri info` 识别配置。但:

- 应用 icon 是 1x1 透明 RGBA 占位 PNG(`crates/perga-tauri/icons/`);bundle
  出的 deb / AppImage 没图标。
- Windows / macOS 桌面 build **未实测**;架构兼容、Cargo.toml 不带 OS-specific
  代码,但没真跑过 `cargo build --target` 验证。
- AppImage / deb **没签名 / 没 updater**:用户下载 unsigned 包要手动
  approve;无内置升级路径。

**触发条件**:正式发布 v1 桌面包之前。

**要做**:

1. **Icon 完整稿**:画一套 32 / 128 / 128@2x / 512 + .ico + .icns,跑
   `cargo tauri icon <source.png>` 生成全套。
2. **Windows / macOS 实测**:`cargo build` 跨编译,验证 webview 调用与 PTY/
   portable-pty 在 macOS / Windows 都过。
3. **Tauri updater plugin**:`cargo add tauri-plugin-updater`,签名 keypair 用
   `cargo tauri signer generate`,发布 endpoint 配 GitHub Releases。
4. **代码签名**:Linux 不强制;Windows / macOS 各自 EV cert / Developer ID。

**涉及**:`crates/perga-tauri/{tauri.conf.json,icons/}`、`web/`(打包流程)。

---
