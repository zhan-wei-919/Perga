# Perga TODO — 延后工作

记录**有意延后**的工作:打了 stopgap 的实现、留下的已知限制、绑定某个未来阶段的后续项。用法见 [`CLAUDE.md`](CLAUDE.md) 的「延后工作:TODO.md」一节。

这里不是 phase 规划(阶段计划在 `docs/state-*.md` 快照里),只放「当前代码里明知不完整、将来要回来补」的具体条目。做完一条就删一条,git 历史保留痕迹。

---

## autotest:输入回显阶段仍用静默窗口

**现状**:`web/src/util/autotest.ts` 的**命令执行阶段**已改用 `command_block`
协议事件确定性判定结束(Phase 3 落地),`run()` 循环也补了确定性单元测试。
但**输入回显阶段**(把命令逐字符打进去、等回显落定)仍用静默窗口启发式。

**已知偏差**:回显阶段不计入耗时统计,只为把「回显」与「命令输出」两段事件
流分开;静默窗口在这里的偏差无害,但仍是启发式。

**触发条件**:若要让回显阶段也确定化。需要后端把 `command_start`(OSC 133 C)
也作为协议事件下发 —— Phase 3 刻意只发了 `command_block`(见
`docs/state-2026-05-21.md` §12 决策)。

**涉及**:`web/src/util/autotest.ts`、`crates/terminal-protocol/src/event.rs`。

---

## 后台 tab 的 dispatch 不暂停

**现状**:Phase 2 每个 pane 一条独立 WS。切换 tab 时,后台 tab 的 pane canvas 会
卸载(不再渲染),但它的 WS 仍保活、`LeafSession.onEvent` 仍逐事件跑
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

## 视觉量 hard-code,待 settings 面板做成可配置

**现状**:Phase 2 的若干视觉量直接写死在组件里:

- `pane_tree_view.tsx` 的 split gutter(分割线)宽度 = 2px。
- focused pane 当前**没有视觉指示** —— 原蓝色 focus ring 已按用户反馈移除,
  多 pane 时只能靠光标活动判断焦点。

**已知偏差**:用户无法调节分割线粗细、配色,也无法选择 / 开关焦点视觉。

**触发条件**:Phase 4(Zoom + 主题 + 视觉抛光,见 `docs/state-2026-05-21.md`
§8)落地 `web/src/ui/settings_panel.tsx` 时。

**要做**:把 gutter 宽度、主题色、焦点视觉样式等收进 `Settings`,由一个控制
面板式的设置界面调节,并持久化到 localStorage。

**涉及**:`web/src/ui/pane_tree_view.tsx`、`web/src/ui/pane_leaf.tsx`。

---

## 命令块:scrollback 饱和(10000 行)后绝对行号会漂

**现状**:`TerminalEngine` 用 alacritty `history_size()` 的增量累计
`scroll_total`,得到跨滚动稳定的绝对行号。scrollback 上限是
`Config::default()` 的 10000 行;一旦 `history_size()` 饱和在 10000,增量恒
0,`scroll_total` 不再推进,绝对行号开始漂移。

**已知偏差**:只影响「单条命令输出 > 10000 行」或「会话已滚 >10000 行且有
未结束的在途命令」。命令块在 command-end 才组装,所以只有在途的超长命令受
影响;超出 10000 行的内容 alacritty 本来也已丢弃。`translate_grid_row` 的
clamp 把取不到的行兜底成空白行,不 panic。

**触发条件**:实测有人跑出 >10000 行的单条命令、且命令块明显丢行 / 错位时。

**涉及**:`crates/terminal-engine/src/engine.rs`(`scroll_total`、`feed`)。

---

## 命令块:resize 后到下一条命令之间,Canvas 与旧块短暂重叠

**现状**:resize 会触发 reflow、让绝对行号失真,所以 `TerminalEngine::resize`
重新基准化 —— `scroll_total` 归零、`last_block_end` 清空。于是 `active_top`
回到 0、Canvas 重新渲染整个视口;而前端 BlockList 里上一批命令块还在。在
「resize 完成」到「下一条命令 command-end」之间,最近一屏内容会同时出现在
Canvas 和 DOM 块里。

**已知偏差**:纯视觉重叠,跑下一条命令即自愈;resize 后通常很快有下一条命令,
窗口很短。

**触发条件**:实测觉得 resize 后的重叠明显碍眼时。根治需要后端在 resize 后
能重新定位「当前活动区起点」(此时没有 mark 可依据)。

**涉及**:`crates/terminal-engine/src/engine.rs`、`web/src/render/grid_canvas.tsx`。

---

## 命令块:有 DOM 选区时 Ctrl+C 仍发 SIGINT

**现状**:命令块是可选中的 DOM(`user-select: text`),但 pane 的键盘处理把
Ctrl+C 编码成终端 SIGINT 字节并 `preventDefault`,所以选中块文本后按 Ctrl+C
不会复制,得用右键菜单 → 复制。

**已知偏差**:块文本「能选不能用 Ctrl+C 复制」,与「可选中复制」的预期有落差。

**触发条件**:做选择 / 复制体验抛光时(可与 Phase 7+ 的跨界选择一并处理)。

**要做**:`web/src/input/keyboard.ts` 在 `window.getSelection()` 非空时,让
Ctrl+C 走浏览器默认复制而非发 SIGINT。

**涉及**:`web/src/input/keyboard.ts`。

---

## shell 集成需手动 source,未做自动注入

**现状**:命令块依赖 shell 发 OSC 133,这要 shell 先 `source
scripts/perga-{bash,zsh}.sh`。Phase 3 出的是 **opt-in 脚本**:用户自己 source
(或加进 `~/.bashrc` / `~/.zshrc`)。没 source → 收不到标记 → 无命令块,退化
成纯终端。

**已知偏差**:让用户手动 source 不是终端该有的 UX。VS Code / iTerm2 / WezTerm
都在 spawn shell 时**自动注入**集成,用户无感。Perga 目前没有。

**触发条件**:命令块体验要打磨,或要给非开发者用时。

**要做**:后端 spawn shell 时注入集成 ——
- bash:`bash --rcfile <wrapper>`,wrapper 先 `source ~/.bashrc` 再 source
  集成(`--rcfile` 会顶替默认 rc,必须自己转源用户配置)。
- zsh:设 `ZDOTDIR` 指向一个 Perga 目录,其中的 `.zshrc` 转源用户真
  `.zshrc` + 集成。
- fish / pwsh:各自的注入点,按需再加。

**涉及**:`crates/perga-server/src/ws.rs`(PtyConfig 构造)、
`crates/perga-cli/src/{main,raw_debug}.rs`、`crates/pty/src/config.rs`、`scripts/`。

---

## `clear` 不清命令块

**现状**:`clear` 发 `CSI [2J` / `[3J`,清的是终端 grid;DOM 命令块独立于
grid、不受影响。所以 `clear` 清掉了实时 Canvas,上方的历史命令块仍在 —— 与
传统终端「`clear` 一下全清」的预期不符(半失效)。`clear` 自身不会成块:它发
的 `CSI 3J` 会触发引擎 `advance_alacritty` 的重新基准化,丢掉在途命令。

**已知偏差**:`clear` 清不掉命令块历史。Warp 靠特判 `clear` / Ctrl-L 直接
清块,Perga 没做。

**触发条件**:命令块体验打磨时。

**要做**:后端在 `advance_alacritty` 检测到 `history_size` 回落(`CSI 3J`,
= 用户要干净台面的强信号)时,除了重新基准化,再发一个新协议事件(如
`clear_blocks`);前端收到就清空 `state.blocks`。检测点已经存在,只差把它
变成一个协议事件。

**涉及**:`crates/terminal-engine/src/engine.rs`(`advance_alacritty` 已检测
回落)、`crates/terminal-protocol/src/event.rs`、
`crates/terminal-session/src/event_loop.rs`、
`web/src/state/{protocol,session_store}.ts`。
