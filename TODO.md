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

**触发条件**:Phase 3(OSC 133 + Warp 命令块)落地后。届时前端会收到 `command_start` / `command_end` 协议事件(见 `docs/state-2026-05-18.md` §7)。

**要做**:

1. `AutoBench` 改用 `command_end` 事件精确判定命令结束,删掉 `QUIET_MS` / `waitSettle` 的静默轮询;`command_start` 替代阶段 1 的回显 settle 窗口。
2. `timeouts` 计数和 `MAX_COMMAND_MS` 退化为纯安全网,正常路径不再命中。
3. 检测变确定性后,给 `run()` 的循环补单元测试 —— 当前 `web/tests/autotest.spec.ts` 只覆盖纯统计 helper,状态机因为依赖真实计时器没测。用合成的 `command_start` / `command_end` 事件流就能确定性地测完整循环。

**涉及**:`web/src/util/autotest.ts`、`web/tests/autotest.spec.ts`。
