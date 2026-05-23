// 终端 selection 的坐标、overlay 和复制语义测试。

import { describe, expect, it } from "vitest";

import {
  normalizeSelection,
  pointFromContentOffset,
  selectedText,
  selectionRects,
  type TerminalSelection,
} from "../src/input/terminal_selection";
import { emptyHistory, pushHistoryRows } from "../src/state/history";
import type { Cell, Color } from "../src/state/protocol";

const FG: Color = { named: "foreground" };
const BG: Color = { named: "background" };
const RED: Color = { named: "red" };
const ACUTE = "́";

function cell(ch: string, opts: Partial<Cell> = {}): Cell {
  return {
    ch,
    combining: [],
    width: "single",
    fg: FG,
    bg: BG,
    attrs: [],
    ...opts,
  };
}

function row(text: string): Cell[] {
  return [...text].map((ch) => cell(ch));
}

describe("pointFromContentOffset", () => {
  const layout = {
    rowCount: 10,
    cols: 80,
    cellW: 10,
    cellH: 20,
    textLeftPx: 6,
  };

  it("maps content pixels to terminal row and cell boundary", () => {
    expect(pointFromContentOffset(21, 45, layout)).toEqual({ row: 2, col: 1 });
  });

  it("clamps outside the terminal text box", () => {
    expect(pointFromContentOffset(-100, -10, layout)).toEqual({ row: 0, col: 0 });
    expect(pointFromContentOffset(2000, 1000, layout)).toEqual({
      row: 9,
      col: 80,
    });
  });

  it("biases drag head toward the crossed cell", () => {
    const anchor = { row: 2, col: 4 };
    expect(pointFromContentOffset(48, 45, layout, anchor)).toEqual({
      row: 2,
      col: 5,
    });
    expect(pointFromContentOffset(43, 45, layout, anchor)).toEqual({
      row: 2,
      col: 3,
    });
  });
});

describe("normalizeSelection", () => {
  it("keeps forward ranges and flips reverse ranges", () => {
    const forward: TerminalSelection = {
      anchor: { row: 1, col: 2 },
      head: { row: 3, col: 4 },
    };
    expect(normalizeSelection(forward)).toEqual({
      start: { row: 1, col: 2 },
      end: { row: 3, col: 4 },
    });

    const reverse: TerminalSelection = {
      anchor: { row: 3, col: 4 },
      head: { row: 1, col: 2 },
    };
    expect(normalizeSelection(reverse)).toEqual({
      start: { row: 1, col: 2 },
      end: { row: 3, col: 4 },
    });
  });
});

describe("selectionRects", () => {
  it("builds one overlay rect per selected visible row", () => {
    const rects = selectionRects(
      {
        anchor: { row: 1, col: 2 },
        head: { row: 3, col: 1 },
      },
      {
        rowCount: 5,
        cols: 5,
        cellW: 10,
        cellH: 20,
        textLeftPx: 6,
        visibleStartRow: 0,
        visibleEndRow: 5,
      },
    );

    expect(rects).toEqual([
      { row: 1, top: 20, left: 26, width: 30, height: 20 },
      { row: 2, top: 40, left: 6, width: 50, height: 20 },
      { row: 3, top: 60, left: 6, width: 10, height: 20 },
    ]);
  });

  it("clips overlay rects to the visible row window", () => {
    const rects = selectionRects(
      {
        anchor: { row: 1, col: 2 },
        head: { row: 3, col: 1 },
      },
      {
        rowCount: 5,
        cols: 5,
        cellW: 10,
        cellH: 20,
        textLeftPx: 0,
        visibleStartRow: 2,
        visibleEndRow: 3,
      },
    );

    expect(rects).toEqual([
      { row: 2, top: 40, left: 0, width: 50, height: 20 },
    ]);
  });
});

describe("selectedText", () => {
  it("copies across history and active grid rows", () => {
    const history = emptyHistory();
    pushHistoryRows(history, [row("hist  ")], 0);
    const grid = [row("grid  ")];

    expect(
      selectedText(
        {
          anchor: { row: 0, col: 0 },
          head: { row: 1, col: 4 },
        },
        {
          history,
          grid,
          historyLen: 1,
          gridRows: 1,
          cols: 6,
          altScreen: false,
        },
      ),
    ).toBe("hist\ngrid");
  });

  it("preserves interior spaces in ls-style columns", () => {
    const history = emptyHistory();
    const grid = [row("apps    key  ")];

    expect(
      selectedText(
        {
          anchor: { row: 0, col: 0 },
          head: { row: 0, col: 13 },
        },
        {
          history,
          grid,
          historyLen: 0,
          gridRows: 1,
          cols: 13,
          altScreen: true,
        },
      ),
    ).toBe("apps    key");
  });

  it("handles wide cells, combining marks, hidden cells, and padding trim", () => {
    const history = emptyHistory();
    const grid = [
      [
        cell("中", { width: "wide" }),
        cell(" ", { width: "wide_spacer" }),
        cell("e", { combining: [ACUTE] }),
        cell("x", { attrs: ["hidden"] }),
        cell(" ", { bg: RED }),
        cell(" "),
      ],
    ];

    expect(
      selectedText(
        {
          anchor: { row: 0, col: 0 },
          head: { row: 0, col: 6 },
        },
        {
          history,
          grid,
          historyLen: 0,
          gridRows: 1,
          cols: 6,
          altScreen: true,
        },
      ),
    ).toBe("中é  ");
  });
});
