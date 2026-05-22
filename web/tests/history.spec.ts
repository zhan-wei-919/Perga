// scrollback 累积 + 虚拟窗口计算(history.ts)。纯函数单测。

import { describe, expect, it } from "vitest";

import {
  HISTORY_MAX,
  clearHistory,
  computeWindow,
  emptyHistory,
  markFailure,
  pushHistoryRows,
} from "../src/state/history";
import type { Cell } from "../src/state/protocol";

function row(text: string): Cell[] {
  return [...text].map((ch) => ({
    ch,
    combining: [],
    width: "single" as const,
    fg: { named: "foreground" as const },
    bg: { named: "background" as const },
    attrs: [],
  }));
}

describe("pushHistoryRows", () => {
  it("appends rows with sequential abs from baseAbs", () => {
    const buf = emptyHistory();
    pushHistoryRows(buf, [row("a"), row("b")], 10);
    expect(buf.rows.map((r) => r.abs)).toEqual([10, 11]);
    expect(buf.rows.map((r) => r.cells[0].ch)).toEqual(["a", "b"]);
  });

  it("accumulates across calls", () => {
    const buf = emptyHistory();
    pushHistoryRows(buf, [row("a")], 0);
    pushHistoryRows(buf, [row("b")], 1);
    expect(buf.rows.length).toBe(2);
    expect(buf.rows[1].abs).toBe(1);
  });

  it("truncates to HISTORY_MAX, dropping oldest", () => {
    const buf = emptyHistory();
    const rows = Array.from({ length: HISTORY_MAX + 50 }, () => row("x"));
    pushHistoryRows(buf, rows, 0);
    expect(buf.rows.length).toBe(HISTORY_MAX);
    // 最旧 50 行被丢弃 → 首个保留行 abs = 50。
    expect(buf.rows[0].abs).toBe(50);
  });

  it("prunes failed marks of dropped rows on truncation", () => {
    const buf = emptyHistory();
    markFailure(buf, 5); // abs 5 会随截断被丢弃
    markFailure(buf, 9999); // 仍在保留区
    pushHistoryRows(
      buf,
      Array.from({ length: HISTORY_MAX + 50 }, () => row("x")),
      0,
    );
    expect(buf.failed.has(5)).toBe(false);
    expect(buf.failed.has(9999)).toBe(true);
  });
});

describe("clearHistory", () => {
  it("empties rows and failed", () => {
    const buf = emptyHistory();
    pushHistoryRows(buf, [row("a")], 0);
    markFailure(buf, 0);
    clearHistory(buf);
    expect(buf.rows.length).toBe(0);
    expect(buf.failed.size).toBe(0);
  });
});

describe("computeWindow", () => {
  it("empty history → empty window", () => {
    expect(computeWindow(0, 400, 18, 0, 8)).toEqual({ start: 0, end: 0 });
  });

  it("covers visible range plus overscan", () => {
    // scrollTop 360 / 行高 18 → firstVisible 20;视口 180 → 10 行可见。
    const w = computeWindow(360, 180, 18, 1000, 8);
    expect(w.start).toBe(12); // 20 - 8
    expect(w.end).toBe(38); // 20 + 10 + 8
  });

  it("clamps start/end to [0, historyLen]", () => {
    expect(computeWindow(0, 180, 18, 1000, 8).start).toBe(0);
    // 滚动远超内容 → start/end 都钳到 historyLen,窗口为空。
    const w = computeWindow(100000, 180, 18, 1000, 8);
    expect(w).toEqual({ start: 1000, end: 1000 });
  });
});
