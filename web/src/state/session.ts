// Session 视图模型类型 + raw grid 的构建 / 解码 helper。
//
// 职责拆分:
// - 本文件:纯函数 —— RLE entry 解码、raw grid 的创建与按行覆盖、view state
//   初值。不依赖 Solid,Vitest 直接喂 JSON 跑断言。
// - `session_store.ts`:把这些 helper 接到 Solid `createStore`;grid 留在 store
//   外作为普通 Cell[][] backing buffer,渲染热路径不穿 Solid proxy。
//
// 设计选择:grid 在内存里**展开成 Cell[][]**,而不是缓存 RLE。
// - 渲染热路径(Canvas redraw)按 (row, col) 随机访问 cell,展开后是 O(1)。
// - 80×24 = 1920 cell,patch 时常态只重写若干行,内存 / GC 都不是瓶颈。
// - RLE 缓存换来的窄带宽优势已经在 wire 端用过了 ── 解码后再保留 RLE 只会
//   让渲染层做二次解码,没意义。

import {
  Cell,
  Color,
  Cursor,
  DEFAULT_BG,
  DEFAULT_FG,
  ProtocolEvent,
  RowEntry,
  TerminalModes,
  TerminalSize,
} from "./protocol";

/// Solid store 持有的视图状态。**不含 grid** ── grid 是普通 Cell[][] backing
/// buffer,由 session_store 在 store 外持有,避免渲染热路径穿 Solid proxy。
export type SessionViewState = {
  size: TerminalSize;
  cursor: Cursor;
  modes: TerminalModes;
  title: string | null;
  // 每行单调递增 generation,渲染层按它判定哪些 row 需要重绘。
  // Init 一次性把所有行置 1(整屏脏),Patch 只 +1 命中行。
  rowGen: number[];
  // 最后一帧 seq;非单调时调用方可决定是否请求重连 / snapshot。
  seq: number;
  // 子进程是否退出。一旦置 true,后续不再接受输入(WS 也会很快关)。
  exited: boolean;
};

export function blankCell(): Cell {
  return {
    ch: " ",
    combining: [],
    width: "single",
    fg: DEFAULT_FG,
    bg: DEFAULT_BG,
    attrs: [],
  };
}

/// view state 初值。store 在拿到第一帧 Init 前需要一个合法初值。
export function emptyViewState(size: TerminalSize): SessionViewState {
  return {
    size,
    cursor: { row: 0, col: 0, visible: true, style: "block" },
    modes: {
      alt_screen: false,
      app_cursor: false,
      bracketed_paste: false,
      mouse_reporting: "off",
      sgr_mouse: false,
      focus_reporting: false,
    },
    title: null,
    rowGen: new Array(size.rows).fill(0),
    seq: 0,
    exited: false,
  };
}

/// 创建一个 size 对应的全空白 raw grid。
export function blankGrid(size: TerminalSize): Cell[][] {
  const grid: Cell[][] = new Array(size.rows);
  for (let r = 0; r < size.rows; r++) {
    grid[r] = blankRow(size.cols);
  }
  return grid;
}

function blankRow(cols: number): Cell[] {
  const row: Cell[] = new Array(cols);
  for (let c = 0; c < cols; c++) row[c] = blankCell();
  return row;
}

/// 用一帧 Init 的行数据**原地**重建 raw grid。
///
/// 原地改(`grid.length` + 逐行赋值)而非返回新数组 ── 调用方(session_store)
/// 把同一个 grid 引用交给了 renderer,引用必须保持稳定。
export function replaceGridRows(
  grid: Cell[][],
  rows: RowEntry[][],
  size: TerminalSize,
): void {
  grid.length = size.rows;
  for (let r = 0; r < size.rows; r++) {
    const entries = rows[r] ?? [];
    grid[r] = expandRowEntries(entries, size.cols);
  }
}

/// 把一帧 Patch 的 dirty rows **原地**写进 raw grid,返回实际改动的行号 ──
/// 调用方据此 bump 对应的 `rowGen`。
export function applyDirtyRowsToGrid(
  grid: Cell[][],
  dirtyRows: Extract<ProtocolEvent, { type: "patch" }>["dirty_rows"],
  size: TerminalSize,
): number[] {
  const touched: number[] = [];
  for (const dr of dirtyRows) {
    if (dr.index < 0 || dr.index >= size.rows) {
      // 行号越界:protocol 违反。不 panic,继续 ── 下一行可能仍然合法。
      continue;
    }
    grid[dr.index] = expandRowEntries(dr.entries, size.cols);
    touched.push(dr.index);
  }
  return touched;
}

/// 把 RLE entries 展开成 cols 列的 cell 数组。
///
/// 协议契约:entries 顺序展开后必须正好覆盖 cols 列。**这里不补 panic**,
/// 因为协议是上游的契约,真有错应该在 wire 反序列化阶段就拒掉(`type` 标签
/// 缺失走 JSON.parse 报错);本函数在被 vitest 单测覆盖的边界上,对越界 entry
/// 截断、不足部分用 blank 填,目的是**不让渲染层崩**,问题在日志里冒头即可。
export function expandRowEntries(
  entries: RowEntry[],
  cols: number,
): Cell[] {
  const out: Cell[] = new Array(cols);
  let col = 0;

  for (const e of entries) {
    if (col >= cols) break;

    if (e.type === "blank") {
      const end = Math.min(cols, col + e.count);
      while (col < end) {
        out[col++] = blankCell();
      }
    } else if (e.type === "text") {
      // Text 协议契约:每个 char 占 1 列(单宽,无 combining)。
      const fg: Color = e.fg ?? DEFAULT_FG;
      const bg: Color = e.bg ?? DEFAULT_BG;
      const attrs = e.attrs ?? [];
      for (const ch of e.s) {
        if (col >= cols) break;
        out[col++] = { ch, combining: [], width: "single", fg, bg, attrs };
      }
    } else {
      // Cells:wide + spacer / 带 combining。一个 cell 占 1 列(协议层语义)。
      for (const c of e.cells) {
        if (col >= cols) break;
        out[col++] = c;
      }
    }
  }

  // 协议违反兜底:不足 cols 的部分填 blank。出现这种情况意味着 encoder 有 bug,
  // 应在日志里冒头;但渲染层不该因此崩。
  while (col < cols) out[col++] = blankCell();
  return out;
}
