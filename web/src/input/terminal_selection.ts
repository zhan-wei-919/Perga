// 终端级 selection 的纯逻辑。
//
// DOM 只负责画 cell;选择/复制必须按终端坐标做,否则空白 cell、宽字符、
// history 虚拟化都会被浏览器原生 selection 误解。

import type { HistoryBuffer } from "../state/history";
import type { Cell, Color } from "../state/protocol";
import { DEFAULT_BG, DEFAULT_FG } from "../state/protocol";

export type SelectionPoint = {
  /** 统一 display row:非 alt-screen 时 history 在前、active grid 在后。 */
  row: number;
  /** Cell 边界列,范围是 [0, cols]。 */
  col: number;
};

export type TerminalSelection = {
  anchor: SelectionPoint;
  head: SelectionPoint;
};

export type NormalizedSelection = {
  start: SelectionPoint;
  end: SelectionPoint;
};

export type SelectionHitTestLayout = {
  rowCount: number;
  cols: number;
  cellW: number;
  cellH: number;
  textLeftPx: number;
};

export type SelectionRectLayout = SelectionHitTestLayout & {
  visibleStartRow: number;
  visibleEndRow: number;
};

export type SelectionRect = {
  row: number;
  top: number;
  left: number;
  width: number;
  height: number;
};

export type TerminalSelectionTextSource = {
  history: HistoryBuffer;
  grid: Cell[][];
  historyLen: number;
  gridRows: number;
  cols: number;
  altScreen: boolean;
};

export function terminalDisplayRowCount(
  historyLen: number,
  gridRows: number,
  altScreen: boolean,
): number {
  return altScreen ? gridRows : historyLen + gridRows;
}

export function pointFromContentOffset(
  contentX: number,
  contentY: number,
  layout: SelectionHitTestLayout,
  anchor?: SelectionPoint,
): SelectionPoint {
  if (
    layout.rowCount <= 0 ||
    layout.cols <= 0 ||
    layout.cellW <= 0 ||
    layout.cellH <= 0
  ) {
    return { row: 0, col: 0 };
  }

  const row = clamp(
    Math.floor(contentY / layout.cellH),
    0,
    layout.rowCount - 1,
  );
  const rawCol = clamp(
    (contentX - layout.textLeftPx) / layout.cellW,
    0,
    layout.cols,
  );
  const col = anchor
    ? biasedHeadCol(row, rawCol, anchor)
    : Math.floor(rawCol);

  return { row, col: clamp(col, 0, layout.cols) };
}

export function normalizeSelection(
  selection: TerminalSelection,
): NormalizedSelection {
  return comparePoint(selection.anchor, selection.head) <= 0
    ? { start: selection.anchor, end: selection.head }
    : { start: selection.head, end: selection.anchor };
}

export function isCollapsedSelection(selection: TerminalSelection): boolean {
  return comparePoint(selection.anchor, selection.head) === 0;
}

export function selectionRects(
  selection: TerminalSelection | null,
  layout: SelectionRectLayout,
): SelectionRect[] {
  if (!selection || isCollapsedSelection(selection) || layout.rowCount <= 0) {
    return [];
  }

  const normalized = normalizeSelection(selection);
  const firstRow = clamp(normalized.start.row, 0, layout.rowCount - 1);
  const lastRow = clamp(normalized.end.row, 0, layout.rowCount - 1);
  const visibleStart = clamp(layout.visibleStartRow, 0, layout.rowCount);
  const visibleEnd = clamp(layout.visibleEndRow, visibleStart, layout.rowCount);
  const out: SelectionRect[] = [];

  for (
    let row = Math.max(firstRow, visibleStart);
    row <= lastRow && row < visibleEnd;
    row++
  ) {
    const { startCol, endCol } = selectedColsForRow(
      row,
      normalized,
      layout.cols,
    );
    if (endCol <= startCol) continue;
    out.push({
      row,
      top: row * layout.cellH,
      left: layout.textLeftPx + startCol * layout.cellW,
      width: (endCol - startCol) * layout.cellW,
      height: layout.cellH,
    });
  }

  return out;
}

export function selectedText(
  selection: TerminalSelection | null,
  source: TerminalSelectionTextSource,
): string {
  if (!selection || isCollapsedSelection(selection)) return "";

  const rowCount = terminalDisplayRowCount(
    source.historyLen,
    source.gridRows,
    source.altScreen,
  );
  if (rowCount <= 0 || source.cols <= 0) return "";

  const normalized = normalizeSelection(selection);
  const firstRow = clamp(normalized.start.row, 0, rowCount - 1);
  const lastRow = clamp(normalized.end.row, 0, rowCount - 1);
  const lines: string[] = [];

  for (let row = firstRow; row <= lastRow; row++) {
    const { startCol, endCol } = selectedColsForRow(
      row,
      normalized,
      source.cols,
    );
    const cells = cellsForDisplayRow(row, source);
    lines.push(textForCellRange(cells, startCol, endCol, source.cols));
  }

  return lines.join("\n");
}

export function clearBrowserSelection(): void {
  window.getSelection()?.removeAllRanges();
}

function biasedHeadCol(
  row: number,
  rawCol: number,
  anchor: SelectionPoint,
): number {
  const beforeAnchor =
    row < anchor.row || (row === anchor.row && rawCol < anchor.col);
  return beforeAnchor ? Math.floor(rawCol) : Math.ceil(rawCol);
}

function selectedColsForRow(
  row: number,
  selection: NormalizedSelection,
  cols: number,
): { startCol: number; endCol: number } {
  const startCol = row === selection.start.row ? selection.start.col : 0;
  const endCol = row === selection.end.row ? selection.end.col : cols;
  return {
    startCol: clamp(startCol, 0, cols),
    endCol: clamp(endCol, 0, cols),
  };
}

function cellsForDisplayRow(
  row: number,
  source: TerminalSelectionTextSource,
): Cell[] {
  if (source.altScreen) return source.grid[row] ?? [];
  if (row < source.historyLen) return source.history.rows[row]?.cells ?? [];
  return source.grid[row - source.historyLen] ?? [];
}

function textForCellRange(
  cells: Cell[],
  startCol: number,
  endCol: number,
  cols: number,
): string {
  const start = clamp(startCol, 0, cols);
  const end = trimDefaultPadding(cells, start, clamp(endCol, start, cols), cols);
  let out = "";

  for (let col = start; col < end; col++) {
    const cell = cells[col] ?? blankCell();
    if (cell.width === "wide_spacer") continue;
    out += glyphForCopy(cell);
  }

  return out;
}

function trimDefaultPadding(
  cells: Cell[],
  start: number,
  end: number,
  cols: number,
): number {
  if (end < cols) return end;
  let nextEnd = end;
  while (
    nextEnd > start &&
    isDefaultPaddingBlank(cells[nextEnd - 1] ?? blankCell())
  ) {
    nextEnd--;
  }
  return nextEnd;
}

function glyphForCopy(cell: Cell): string {
  if (cell.attrs.includes("hidden")) {
    return cell.width === "wide" ? "  " : " ";
  }
  return cell.combining.length > 0
    ? cell.ch + cell.combining.join("")
    : cell.ch;
}

function isDefaultPaddingBlank(cell: Cell): boolean {
  return (
    cell.ch === " " &&
    cell.combining.length === 0 &&
    cell.width === "single" &&
    cell.attrs.length === 0 &&
    sameColor(cell.fg, DEFAULT_FG) &&
    sameColor(cell.bg, DEFAULT_BG)
  );
}

function blankCell(): Cell {
  return {
    ch: " ",
    combining: [],
    width: "single",
    fg: DEFAULT_FG,
    bg: DEFAULT_BG,
    attrs: [],
  };
}

function comparePoint(a: SelectionPoint, b: SelectionPoint): number {
  if (a.row !== b.row) return a.row - b.row;
  return a.col - b.col;
}

function sameColor(a: Color, b: Color): boolean {
  if ("named" in a) return "named" in b && a.named === b.named;
  if ("rgb" in a) {
    return (
      "rgb" in b &&
      a.rgb.r === b.rgb.r &&
      a.rgb.g === b.rgb.g &&
      a.rgb.b === b.rgb.b
    );
  }
  return "indexed" in b && a.indexed === b.indexed;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
