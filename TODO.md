# Perga TODO — 延后工作

记录**有意延后**的工作:打了 stopgap 的实现、留下的已知限制、绑定某个未来阶段的后续项。用法见 [`CLAUDE.md`](CLAUDE.md) 的「延后工作:TODO.md」一节。

这里不是 phase 规划(阶段计划在 `docs/state-*.md` 快照里),只放「当前代码里明知不完整、将来要回来补」的具体条目。做完一条就删一条,git 历史保留痕迹。

---

## autotest:用 OSC 133 替换静默窗口启发式

**现状**:`web/src/util/autotest.ts` 的 `AutoBench` 用「发出回车后连续 60ms(`QUIET_MS`)无新事件 = 命令结束」的启发式判断单条命令何时跑完。这是 stopgap —— Phase 1 没有 shell integration,客户端没有别的办法知道命令边界。

**已知偏差**:

- 长命令 / 流式输出中途出现 >60ms 间隙会被误判为结束。
- 每条命令固定多花 ~60ms 空等,加上一段输入回显的 settle 窗口。
- 命令进了交互态(vim、分页器)永远不静默,只能靠 `MAX_COMMAND_MS` 超时兜底。

**触发条件**:Phase 3(OSC 133 + Warp 命令块)落地后。届时前端会收到 `command_start` / `command_end` 协议事件(见 `docs/state-2026-05-20.md` §7)。

**要做**:

1. `AutoBench` 改用 `command_end` 事件精确判定命令结束,删掉 `QUIET_MS` / `waitSettle` 的静默轮询;`command_start` 替代阶段 1 的回显 settle 窗口。
2. `timeouts` 计数和 `MAX_COMMAND_MS` 退化为纯安全网,正常路径不再命中。
3. 检测变确定性后,给 `run()` 的循环补单元测试 —— 当前 `web/tests/autotest.spec.ts` 只覆盖纯统计 helper,状态机因为依赖真实计时器没测。用合成的 `command_start` / `command_end` 事件流就能确定性地测完整循环。

**涉及**:`web/src/util/autotest.ts`、`web/tests/autotest.spec.ts`。

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

**触发条件**:Phase 4(Zoom + 主题 + 视觉抛光,见 `docs/state-2026-05-20.md`
§8)落地 `web/src/ui/settings_panel.tsx` 时。

**要做**:把 gutter 宽度、主题色、焦点视觉样式等收进 `Settings`,由一个控制
面板式的设置界面调节,并持久化到 localStorage。

**涉及**:`web/src/ui/pane_tree_view.tsx`、`web/src/ui/pane_leaf.tsx`。
