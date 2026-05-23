# Perga TODO — 延后工作

记录**有意延后**的工作:打了 stopgap 的实现、留下的已知限制、绑定某个未来阶段的后续项。用法见 [`CLAUDE.md`](CLAUDE.md) 的「延后工作:TODO.md」一节。

这里不是 phase 规划(阶段计划在 `docs/state-*.md` 快照里),只放「当前代码里明知不完整、将来要回来补」的具体条目。做完一条就删一条,git 历史保留痕迹。

---

## 终端级选择复制系统未实现

**现状**:普通滚动终端是 `[历史 DOM][活动区 DOM grid]`。历史区
`web/src/render/history_view.tsx` 和活动区 `web/src/render/grid_dom.tsx` 都是
DOM 文本,浏览器原生 selection 已经可以复制当前可见文本。`web/src/input/copy_shortcuts.ts`
目前处理「已有 DOM 文本选区时 Ctrl/Cmd+C 走浏览器复制,否则 Ctrl+C 发 SIGINT」。

**已知偏差**:

- 浏览器原生复制只覆盖当前 DOM 中实际存在的可见文本;history 虚拟化窗口外的
  行不会进入一次原生选区。
- 复制结果没有终端语义归一化:宽字符 / `wide_spacer` / 行尾空白 / 矩形选区等
  规则还没有统一坐标模型。
- 还没有终端 selection overlay,无法支持拖拽自动滚动、双击选词、三击选行等
  终端常见交互。

**触发条件**:实现复制功能时。活动区已是 DOM grid,下一步做最小闭环:
统一 history+grid 坐标模型、鼠标拖拽选区、overlay 高亮、`Ctrl/Cmd+C` 有终端
选区时拼纯文本写入 clipboard、无选区时 `Ctrl+C` 继续发 SIGINT。先不做双击
选词、三击选行、块选择和拖拽自动滚动。

**涉及**:`web/src/ui/pane_leaf.tsx`,`web/src/render/history_view.tsx`,
`web/src/render/grid_dom.tsx`,`web/src/state/history.ts`,
`web/src/state/session_store.ts`,`web/src/input/copy_shortcuts.ts`。

---

## 前端鼠标上报未接入

**现状**:后端 mouse 输入链路已存在:`crates/perga-server/src/wire.rs` 能解析
`ClientMessage::Mouse`,`crates/terminal-session/src/event_loop.rs` 会调用
`terminal-input::encode_mouse`,前端 `web/src/state/wire.ts` 也有 mouse wire
类型。但 `web/src/ui/pane_leaf.tsx` 还没有 pointer / wheel listener 把浏览器
鼠标事件换算成终端 `(row,col)` 后发送 `{ type:"mouse", ... }`。

**已知偏差**:

- `vim` / `less` / `tmux` / `htop` / `lazygit` 等 TUI 即使开启 mouse reporting,
  也收不到前端鼠标点击、拖拽、滚轮。
- 终端选择复制先做时可以默认接管拖拽;但后续接入 mouse reporting 后,必须在
  `session.store.state.modes.mouse_reporting !== "off"` 时默认把鼠标交给 TUI,
  并保留 `Shift/Alt+Drag` 这类强制前端选择的修饰键路径。

**触发条件**:用户需要 TUI 鼠标操作,或终端选择复制实现到需要最终确定
selection vs TUI mouse 的事件优先级时。

**涉及**:`web/src/ui/pane_leaf.tsx`,`web/src/state/wire.ts`,
`crates/perga-server/src/wire.rs`,`crates/terminal-session/src/event_loop.rs`,
`crates/terminal-input/src/encoder.rs`。

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

## 移动端打包目标(Android / iOS)

**现状**:Phase 6 v1 完成了**前端**移动端 UX hooks(`web/src/util/platform.ts`
+ `web/src/ui/profile_picker.tsx` + tab_bar 的 `+` 分支),并通过
`?platform=mobile` 在浏览器里能验证。但**实际 Android / iOS bundle 没打**——
v1 只打 Linux。

**已知偏差**:

- 工作区启动还是会无条件创建一个 default local-shell tab(`createWorkspace`
  里 `tabs: [makeTab()]` 硬编)。在 Tauri mobile 上 `portable-pty` 不可用,
  这个 default tab 会失败。当前用 `forceSetup=true` 的 picker modal 抢覆盖,
  但 default tab 仍是僵尸。
- `crates/pty` / `crates/ssh` 没加 `#[cfg(not(any(target_os = "android",
  target_os = "ios")))]` gate;`cargo check --target aarch64-linux-android` 会
  在 portable-pty 上炸。

**触发条件**:实际要在平板上发版时。

**要做**:

1. **PTY cfg gate**:`crates/pty` 改成只在桌面 target 编;`terminal-session::spawn_local`
   也跟着 gate;`perga-core::session_factory::open_local` 在 mobile target 直接
   `unreachable!()` 或 panic。
2. **Workspace 初始 tab**:平台是 mobile 时不预创建 default tab,workspace
   `tabs` 起步为空,picker 用户选一个 profile 才 newTab。需要解开"必有一
   tab"的 invariant 或允许 zero-tab 启动态。
3. **Android signing** + **iOS Apple Developer**:走 `cargo tauri android init` /
   `cargo tauri ios init`,准备 keystore 与签名 profile。
4. **真机调试**:`cargo tauri android dev` / `ios dev` 走 USB / 模拟器。

**涉及**:`crates/pty/Cargo.toml` + lib.rs(cfg gate)、`crates/perga-core/src/session_factory.rs`、
`crates/perga-tauri/`(Android / iOS init)、`web/src/state/workspace.ts`(zero-tab
初始态)。

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

## Default-tab 启动 vs Tauri mobile

**现状**:`createWorkspace()` 同步初始化时强制 `tabs: [makeTab()]`,即
"workspace 永远 ≥1 tab" invariant。Phase 6 v1 移动端 UX 通过 `forceSetup`
picker 抢一个覆盖层,但底下那个 local-shell tab 仍然存在,在真 Android / iOS
build 上会 spawn 失败。

**触发条件**:同上 "移动端打包目标"。要等到第一次跑 mobile bundle、看到
default tab 失败时一并改。

**要做**:
- 选项 A:解开 "≥1 tab" invariant,允许 zero-tab 启动态;picker 选 profile
  后才 `newTabWithProfile`。
- 选项 B:`createWorkspace(initialProfileId?)` 接收 init,平台层在 mobile
  形态下不传 → 不预创建。需要异步初始化(picker → 选 profile → 装载)。

**涉及**:`web/src/state/workspace.ts`、`web/src/ui/app.tsx`。
