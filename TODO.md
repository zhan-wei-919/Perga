# Perga TODO — 延后工作

记录**有意延后**的工作:打了 stopgap 的实现、留下的已知限制、绑定某个未来阶段的后续项。用法见 [`CLAUDE.md`](CLAUDE.md) 的「延后工作:TODO.md」一节。

这里不是 phase 规划(阶段计划在 `docs/state-*.md` 快照里),只放「当前代码里明知不完整、将来要回来补」的具体条目。做完一条就删一条,git 历史保留痕迹。

---

## 活动区主渲染从 Canvas 改成 DOM 行渲染

**现状**:活动区仍由 `web/src/render/grid_canvas.tsx` 用 Canvas 2D 绘制。已经
修过多轮残影问题(旧光标整行重画、行重绘前整行清背景、CJK 宽度测量兜底、
`fillText` clip),但中文 / fallback 字体 / 小数 cell 宽度 / 抗锯齿边界仍然
容易出现视觉瑕疵。历史区 `web/src/render/history_view.tsx` 已经是 DOM 行 +
`row_segments.ts` 的 run segment 渲染,视觉和复制天然更接近浏览器文本。

**已知偏差**:

- Canvas 字体效果和浏览器 DOM 文本相比差,中文尤其明显。
- 为了修 Canvas 残影不断增加局部补丁,复杂度继续上升。
- 后续终端选择复制 / IME / 选区高亮仍要围绕 Canvas 做额外 overlay 和文本
  拼接;如果活动区也 DOM,这些功能会更直接。

**触发条件**:开始做复制系统前,优先把活动区主 renderer 切到 DOM。做法:

- 新增 `web/src/render/grid_dom.tsx`,复用 `row_segments.ts`。
- **不要** per-cell DOM。按行渲染,每行由连续同样 style 的 segment `<span>`
  组成,类似 Canvas run-grouping。
- 光标和 selection 高亮用绝对定位 overlay,按 `cellW/cellH` 定位。
- `PaneLeaf` 先用常量 / 设置切换 DOM grid 与 Canvas grid;Canvas 暂留作
  fallback / 性能对比,不要立刻删除。
- 继续以 raw `Cell[][]` + `rowGen` 驱动,避免把 grid 放回 Solid store。

**涉及**:`web/src/render/grid_dom.tsx`(新),`web/src/render/row_segments.ts`,
`web/src/ui/pane_leaf.tsx`,`web/src/render/grid_canvas.tsx`,
`web/src/render/metrics.ts`,`web/tests/grid_canvas.spec.ts`。

---

## 终端选择复制系统未实现

**现状**:普通滚动终端已改成 `[历史 DOM][活动区 Canvas]`。历史区
`web/src/render/history_view.tsx` 可以靠浏览器原生 selection 复制;活动区
`web/src/render/grid_canvas.tsx` 是 Canvas,浏览器无法选中其中的当前 prompt /
当前屏文字。`web/src/input/copy_shortcuts.ts` 目前只处理「已有 DOM 文本选区
时 Ctrl/Cmd+C 走浏览器复制,否则 Ctrl+C 发 SIGINT」。

**已知偏差**:

- 不能复制当前活动区 Canvas 里的文本。
- 不能跨 history + 当前屏一次性复制。
- 复制行为还没有终端 selection overlay,也没有宽字符 / `wide_spacer` 的复制
  文本拼接规则。

**触发条件**:实现复制功能时。先做上面的 DOM active grid,再做最小闭环:
统一 history+grid 坐标模型、鼠标拖拽选区、overlay 高亮、`Ctrl/Cmd+C` 有终端
选区时拼纯文本写入 clipboard、无选区时 `Ctrl+C` 继续发 SIGINT。先不做双击
选词、三击选行、块选择和拖拽自动滚动。

**涉及**:`web/src/ui/pane_leaf.tsx`,`web/src/render/history_view.tsx`,
`web/src/render/grid_canvas.tsx`,`web/src/state/history.ts`,
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
