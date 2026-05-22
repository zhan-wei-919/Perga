// 前端累积的 scrollback —— 后端在每个 patch 里捎来「滚出 viewport 顶的行」,
// 前端 append 进这个 buffer。纯逻辑,不依赖 Solid。
//
// 每行带一个全局绝对行号 `abs`:跨 resize 唯一(见 session_store 的
// `historyAbsOffset`),失败命令标记按 abs 索引。

import type { Cell } from "./protocol";

/// 历史里的一行:展开后的 cell 数组 + 全局绝对行号。
export type HistoryRow = {
  cells: Cell[];
  abs: number;
};

/// 前端持有的 scrollback。
export type HistoryBuffer = {
  rows: HistoryRow[];
  /// 失败命令输入行的全局绝对行号集合。
  failed: Set<number>;
};

/// 历史上限。超出从头丢弃 —— 与 alacritty scrollback 容量对齐。
export const HISTORY_MAX = 10000;

export function emptyHistory(): HistoryBuffer {
  return { rows: [], failed: new Set() };
}

/// 把一批新滚出的行 append 进 history。每行的全局绝对行号 = `baseAbs + i`。
/// 超过 [`HISTORY_MAX`] 时从头丢弃,并清掉 `failed` 里已失效(行已被丢弃)的项。
export function pushHistoryRows(
  buf: HistoryBuffer,
  rows: Cell[][],
  baseAbs: number,
): void {
  for (let i = 0; i < rows.length; i++) {
    buf.rows.push({ cells: rows[i], abs: baseAbs + i });
  }
  if (buf.rows.length > HISTORY_MAX) {
    buf.rows.splice(0, buf.rows.length - HISTORY_MAX);
    const oldestAbs = buf.rows.length > 0 ? buf.rows[0].abs : Number.POSITIVE_INFINITY;
    for (const abs of [...buf.failed]) {
      if (abs < oldestAbs) buf.failed.delete(abs);
    }
  }
}

/// 标记一个失败命令的输入行(按全局绝对行号)。
export function markFailure(buf: HistoryBuffer, globalLine: number): void {
  buf.failed.add(globalLine);
}

/// 清空 history(`CSI 3J`)。
export function clearHistory(buf: HistoryBuffer): void {
  buf.rows.length = 0;
  buf.failed.clear();
}

/// 虚拟列表可见窗口:给定滚动位置 / 视口高 / 行高 / 历史总行数,算出该渲染
/// 哪一段 `[start, end)`(含上下各 `overscan` 行余量)。纯函数,可单测。
export function computeWindow(
  scrollTop: number,
  clientHeight: number,
  lineHeight: number,
  historyLen: number,
  overscan: number,
): { start: number; end: number } {
  if (historyLen <= 0 || lineHeight <= 0) return { start: 0, end: 0 };
  const firstVisible = Math.floor(scrollTop / lineHeight);
  const visibleCount = Math.ceil(clientHeight / lineHeight);
  const start = Math.min(historyLen, Math.max(0, firstVisible - overscan));
  const end = Math.min(historyLen, firstVisible + visibleCount + overscan);
  return { start, end: Math.max(start, end) };
}
