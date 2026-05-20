# Frontend dispatch performance plan

日期:2026-05-20

这份文档记录当前 `ls x100` benchmark 的性能判断和下一步改造方案。它不是长期架构总览;等方案落地并回测后,相关结论应同步进新的 `docs/state-*.md` 快照。

## 当前现象

用户回报的 benchmark:

```text
[perga autotest] "ls" x100 -> 26915.2 ms
latency enter->settle (ms): p50 130.8, p99 143.9
first-event enter->first patch (ms): p50 39.3, p99 46.1
dispatch reducer+setStore+canvas (ms): p50 16.6, p99 43.8, max 50, samples 617
completed 100/100, events 617, timeouts 0
```

本地辅助验证:

- `cargo run --release -p perga-cli --bin perga-bench -- --total 5000000 --chunk 1024`
  显示后端 sync 热路径 p99 是几十微秒级,不是 10ms 量级瓶颈。
- `cargo test --release -p perga-server --test rtt -- --nocapture`
  显示本机 `key -> patch` WS RTT p99 约数百微秒级。
- 直接连 WS 跑 100 次 `ls`,得到约 620 个 patch(与 autotest 的 617 events 一致),
  dirty-row 分布:`0 行 197 / 1 行 211 / 23 行 115 / 24 行 94`。

`total 26.9s` 不是核心指标,因为 `web/src/util/autotest.ts` 现在每条命令至少有两段 60ms quiet window。当前最有价值的指标是单条 `ProtocolEvent` 的 `dispatch p50/p99`。

## 根因判断

后端、网络、parse/encode 都不是瓶颈(见上面三条实测)。问题全在浏览器主线程里每个 patch 的处理成本。按影响排序有三层。

### 根因 #1(主因):增量重绘被禁用,每个 patch 都全屏重画

`web/src/render/grid_canvas.tsx` 的渲染 `createEffect` 开头有一个 canvas 尺寸检查:

```js
if (
  canvasRef.width !== size.cols * metrics.cellW * dpr() ||
  canvasRef.height !== size.rows * metrics.cellH * dpr()
) {
  syncCanvasSize();
  lastGen.length = 0;     // 脏行缓存被清空
  lastCursor = undefined;
}
```

而 `syncCanvasSize()` 写入的是 `canvasRef.width = Math.round(size.cols * metrics.cellW * dpr())`。`metrics.cellW = rect.width / 100`(`metrics.ts`,`getBoundingClientRect` 返回亚像素浮点),几乎不可能是整数。

于是这个比较的左边是 `Math.round(X)`、右边是 `X` 本身 —— **`Math.round(X) !== X` 对任何非整数 X 恒为真**。结果:

- **每个 patch 都进这个分支**:`syncCanvasSize()` 重置整块 canvas backing store(`canvasRef.width = ...` 会清空画布并重置 context state)、做一次全屏 `fillRect` 清屏。
- `lastGen.length = 0` 把脏行缓存清掉 → 紧接的循环里 24 行全部 `gen !== lastGen` → **24 行全部 `drawRow`**。

dirty-row 增量重绘这套设计,被这一行浮点比较 100% 废掉。

证据吻合:dirty-row 分布里 `0 行 + 1 行 = 408/617` 个 patch 本该是亚毫秒级的小重绘,实测 `dispatch` 却全在 16ms 以上;`p50 16.6 / p99 43.8` 比值只有 2.6×,若增量重绘有效,小 patch 会在 ~1ms 量级、比值应是几十倍。`p50` 这么高,正说明小 patch 也在画 24 行。

(这也解释了之前 run-grouping 优化只把 62ms 压到 44ms:那 44ms 一直是全屏 24 行重绘,run-grouping 降低了每行成本,但没人发现每个 patch 都在全屏重绘。)

### 根因 #2(次要放大项):grid 在 Solid store 里

`SessionState.grid: Cell[][]` 整体放在 Solid `createStore` 里。`drawRow` 遍历一行 80 个 cell,读取 `cell.width/fg/bg/attrs/ch/combining` 等大量属性。`untrack(() => props.state.grid[r])` 只阻止 Solid 建立响应式订阅,但 `state.grid[r]` 和 row 内 cell 仍是 Solid store proxy —— 每次属性读取仍走 proxy trap。

实测量级约 **~1ms/行**,是放大项不是主因:它让根因 #1 强制的 24 行重绘更慢,但即使没有根因 #1,单独的 proxy 开销也不会把 1 行 patch 拖到 16ms。

不过这一项**值得独立修复**:renderer 本来就 `untrack` 了 grid,说明 grid 不需要细粒度响应式;它本质是 renderer backing buffer,塞进 `createStore` 是不合适的数据模型(CLAUDE.md §数据模型优先)。

### 根因 #3(事件数量与滚屏放大)

- 后端当前一个 `PtyEvent::Output` 立即对应一个 `ProtocolEvent`,不做 coalescing。
- 协议只有 row diff,没有 scroll op。底部输出触发滚屏时整屏行内容平移,被 diff 成 23/24 行 dirty —— 即上面分布里的 `23 行 115 + 24 行 94 = 209/617`。

这一层影响 `dispatch p99`(真·24 行重绘)和 `latency enter->settle`(patch 数量)。但要注意:**根因 #1 不修,scroll op 完全无效** —— 前端现在每帧清 `lastGen`、无视 dirty-row 数,后端把 24 行脏优化成 1 行脏,前端照样画 24 行。所以这一层必须排在根因 #1 之后。

## 验证假设(动生产代码前)

按 CLAUDE.md §Bug 修复流程,改生产代码前先把怀疑变成可证伪的测试:

- 在 `drawRow` 入口加一个计数器,跑几个 patch 打印每个 `dispatch` 触发的 `drawRow` 次数。
- 预测:一个 dirty-row 数为 1 的 patch 会触发 **24 次** `drawRow`(根因 #1 成立)。
- 修复根因 #1 后应为 **1 次**。

这是确定性验证,不依赖 perf 数字波动。确认后再进入下面的步骤。

## 目标

第一阶段目标,分两步达成:

- **步骤 0(修 syncCanvasSize)** → 恢复增量重绘 → `dispatch p50` 从 ~16ms 降到 ~1ms(1 行 patch 只画 1 行)。
- **步骤 1(grid 移出 store)+ 后续 scroll op** → 压低 24 行滚屏 patch 的成本 → `dispatch p99` 从 ~44ms 降到 < 10ms。
- `ls x100` 的 `latency enter->settle p50` 随单 patch 成本下降而明显下降。若 patch 数仍为 ~600,也不应再被单 patch 同步处理拖到 130ms。

## 方案

### 步骤 0:修 syncCanvasSize 比较(一行级,先做)

比较两边都用 round 后的目标值,只有 size / dpr 真正变化时才重建 canvas:

```js
const wantW = Math.round(size.cols * metrics.cellW * dpr());
const wantH = Math.round(size.rows * metrics.cellH * dpr());
if (canvasRef.width !== wantW || canvasRef.height !== wantH) {
  syncCanvasSize();
  lastGen.length = 0;
  lastCursor = undefined;
}
```

零风险,立刻 autotest 回测。预期 `dispatch p50` 16.6 → ~1ms;`p99` 仍由根因 #3 的 209 个滚屏 patch 决定,约 ~25-30ms(此时 grid 仍是 proxy)。

### 步骤 1:把 grid 移出 Solid store

核心模型:

- Solid store 只保存小而稀疏的响应式状态:
  - `size`
  - `cursor`
  - `modes`
  - `title`
  - `rowGen`
  - `seq`
  - `exited`
- `grid: Cell[][]` 作为 raw backing buffer,由 store wrapper 持有,不进入 `createStore`。
- Patch 应用时:
  1. `expandRowEntries(...)` 生成 plain `Cell[]`。
  2. 写入 raw `grid[dr.index]`。
  3. bump Solid store 里的 `rowGen[dr.index]`。
- Renderer 根据 `rowGen` 触发后,从 raw grid 读取对应 row,不再穿 Solid proxy。

建议类型形态:

```ts
export type SessionViewState = {
  size: TerminalSize;
  cursor: Cursor;
  modes: TerminalModes;
  title: string | null;
  rowGen: number[];
  seq: number;
  exited: boolean;
};

export type SessionStore = {
  state: SessionViewState;
  grid: Cell[][];
  dispatch: (ev: ProtocolEvent) => void;
};
```

`GridCanvas` props 改成:

```ts
export type GridCanvasProps = {
  state: SessionViewState;
  grid: Cell[][];
  fontSize?: number;
};
```

这样 `createEffect` 仍订阅 `state.rowGen[r]`,但绘制时读取的是 `props.grid[r]` 里的 plain row。预期把 24 行滚屏 patch 的单行成本从 ~1ms/行(proxy)降到 ~0.3ms/行(plain)。

## 实施步骤

1. **修 syncCanvasSize 比较**(步骤 0)
   - 改 `grid_canvas.tsx` 渲染 effect 里的尺寸检查,见上。
   - 先按「验证假设」加 `drawRow` 计数器证实根因 #1,再修,再确认计数从 24 变 1。
   - 回测一次,记录此时的 `dispatch p50/p99`。

2. **拆分 state 类型**(步骤 1 起)
   - 在 `web/src/state/session.ts` 保留纯 reducer 能力,但把 Solid 用的 view state 与 raw grid 明确分开。
   - 新增 helper:按 size 创建 raw grid;Init 时重建 raw grid;Patch 时覆盖 dirty row。
   - **纯 reducer 路径与 store dispatch 路径必须共用 `expandRowEntries` 和 raw-grid helper**,否则两条路径逻辑会漂移。

3. **修改 `createSessionStore`**
   - `createStore` 只包 view state。
   - `grid` 是闭包内普通数组,通过 `SessionStore.grid` 暴露给 renderer。
   - Init 时先重建 raw grid,再 set view state。
   - Patch 时先更新 raw dirty rows,再在 `produce` 内更新 cursor/seq/modes/title/rowGen。

4. **修改 `GridCanvas`**
   - 从 `props.grid[r]` 取 row。
   - 删除针对 `props.state.grid` 的 `untrack` 读取。
   - 保留 `rowGen` dirty-row 机制和 cursor 单独重绘机制。

5. **修改 `App`**
   - `<GridCanvas state={store.state} grid={store.grid} ... />`。

6. **更新测试**
   - `web/tests/session.spec.ts` 保留纯函数 reducer 覆盖。
   - 给 `createSessionStore` 增加测试:Patch 后 raw grid 对应行变化,只有对应 `rowGen` 增加。
   - 保证 Init 后 raw grid 尺寸与 view `size` 一致。

## 验证

必跑:

```text
cd web
pnpm test
pnpm exec vite build
```

回测:

```text
cargo run --release -p perga-server
cd web && pnpm dev
http://localhost:5173/?perf=1
```

跑 autotest `ls x100`,在**步骤 0 后**和**步骤 1 后**各记录一次:

- `dispatch p50/p99/max`
- `latency enter->settle p50/p99`
- `events`

判断:

- 步骤 0 后:`dispatch p50` 应降到 ~1-2ms。若没有,说明根因 #1 判断错了,回到「验证假设」重查。
- 步骤 1 后:若 `dispatch p50 < 2ms` 且 `p99 < 10ms`,第一阶段达标。
- 若 `p99` 仍 > 10ms,基本是根因 #3 的 209 个滚屏 patch 在拖 —— 进入「后续优化顺序」的 scroll op。
- 若 `events` 仍约 600 但 latency 已显著下降,下一步做 event coalescing。
- 若 `dispatch` 仍异常,再拆指标:单独测 reducer、setStore、drawRow/canvas,不要继续混在一个 `dispatch` 样本里猜。

## 后续优化顺序

1. **修 syncCanvasSize 比较**(根因 #1)。
2. **Raw grid 脱离 Solid store**(根因 #2)。
3. `requestAnimationFrame` 合批 canvas 绘制,让多个 patch 在同一帧只画一次。
4. 后端短窗口 coalescing,把连续 `PtyEvent::Output` 合成较少 `ProtocolEvent`。
5. 协议层增加 scroll op,避免滚屏被 row diff 放大成 23/24 行 dirty(根因 #3)。

顺序理由:

- syncCanvasSize 修的是「增量重绘被禁用」这个 bug,一行、零风险、立刻可回测。**必须最先做** —— 否则后面任何「降低单 patch 成本 / 减少 patch 数」的优化,都建立在「每个 patch 全屏重绘」这个错误基线上,收益无法归因。
- Raw grid 改造修的是单行重绘的固定成本(proxy → plain)。放在 syncCanvasSize 之后,因为只有增量重绘恢复了,才能干净地测出 plain vs proxy 的差。
- RAF 修的是同步阻塞和 burst 合并,但如果 grid 仍是 proxy,只是把慢操作挪到帧回调里。
- 后端 coalescing 会改变事件形态,适合在前端单 patch 成本正常后再做。
- scroll op 是协议语义扩展,收益大但改动面更广;且根因 #1 不修时它完全无效。不作为第一刀。

## 暂不做

- 不先引入虚拟 DOM 行 renderer。当前目标仍是 canvas terminal。
- 不先把协议从 JSON 改成 binary。现有后端 JSON 序列化不是主瓶颈。
- 不把 `Cell` 做成 class 或复杂结构。第一刀只调整响应式边界,保持数据模型简单。
- 不把所有绘制都搬 Worker/OffscreenCanvas。当前问题还没到需要跨线程渲染的程度。
