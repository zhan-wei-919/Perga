// DOM Grid 渲染器。
//
// 活动区仍按终端二维 cell grid 渲染,但文字交给浏览器 DOM 文本栈。性能模型
// 延续旧 Canvas renderer:
//
// 1. **row-level dirty**:只订阅 `rowGen[r]`,只重建变化行。
// 2. **run-grouping**:同 `(fg,bg,attrs)` 的连续单宽 cell 合并成一个 span。
// 3. **RAF 合批**:协议事件只收集 dirty row,下一帧统一提交 DOM mutation。
// 4. **raw grid**:渲染时读取普通 `Cell[][]`,不把 grid 放进 Solid store。
//
// 不做 per-cell DOM。每行最多少量 spans,空间复杂度是 O(rows + runs)。

import { Component, createEffect, onCleanup, untrack } from "solid-js";

import type { Cell, CellAttr, Color, Cursor, TerminalSize } from "../state/protocol";
import { DEFAULT_BG, DEFAULT_FG } from "../state/protocol";
import { useSettings } from "../state/settings_context";
import type { SessionViewState } from "../state/session";
import {
  blockElementModel,
  isBlockElementGlyph,
  isBlockElementRun,
} from "./block_elements";
import {
  boxDrawingModel,
  boxDrawingStemRect,
  isBoxDrawingGlyph,
  isBoxDrawingRun,
  type BoxDrawingStem,
  type BoxDrawingWeight,
} from "./box_drawing";
import { type CellMetrics, measureCell } from "./metrics";
import { colorToDomCss } from "./palette";
import { segmentStyle } from "./row_segments";

export type GridDomProps = {
  state: SessionViewState;
  grid: Cell[][];
  onRenderScheduled?: () => void;
  onRenderFrame?: (durationMs: number) => void;
  /** 已 scheduled 的 RAF 在 flush 前被取消(组件卸载)。 */
  onRenderCancelled?: () => void;
};

export type GridDomSize = {
  cssW: number;
  cssH: number;
};

export type GridRowSegment = {
  xCell: number;
  text: string;
  fg: Color;
  bg: Color;
  attrs: CellAttr[];
  widthCells: number;
};

export type GridRowDebugSegment = Pick<
  GridRowSegment,
  "xCell" | "widthCells" | "text"
>;

export type CursorOverlayModel = {
  x: number;
  y: number;
  width: number;
  height: number;
  marginTop: number;
  text: string;
  color: string;
  background: string;
};

export function gridDomSize(
  size: TerminalSize,
  metrics: Pick<CellMetrics, "cellW" | "cellH">,
): GridDomSize {
  return {
    cssW: size.cols * metrics.cellW,
    cssH: size.rows * metrics.cellH,
  };
}

export const GridDom: Component<GridDomProps> = (props) => {
  const settings = useSettings();
  let rootRef: HTMLDivElement | undefined;
  let cursorRef: HTMLDivElement | undefined;
  let metrics: CellMetrics | undefined;
  let lastSynced:
    | {
        rows: number;
        cols: number;
        cellW: number;
        cellH: number;
        fontFamily: string;
        fontSize: number;
        fixedPitch: boolean;
      }
    | undefined;
  const rowElements: HTMLDivElement[] = [];
  const lastDrawnGen: number[] = [];
  const lastRowSignatures: string[] = [];
  const pendingRows = new Set<number>();
  let lastCursor: Cursor | undefined;
  let rafId: number | undefined;

  createEffect(() => {
    const fontSize = settings.effectiveFontSize();
    const fontFamily = settings.fontFamily();
    if (!rootRef) return;
    metrics = measureCell(fontFamily, fontSize);
    lastSynced = undefined;
    lastDrawnGen.length = 0;
    lastRowSignatures.length = 0;
    syncDomSize(untrack(() => props.state.size));
    queueAllRows(untrack(() => props.state.size));
    scheduleRender();
  });

  createEffect(() => {
    if (!rootRef || !metrics) return;
    let needsRender = false;
    const size = props.state.size;
    if (syncDomSize(size)) {
      queueAllRows(size);
      needsRender = true;
    }

    for (let r = 0; r < size.rows; r++) {
      const gen = props.state.rowGen[r] ?? 0;
      if ((lastDrawnGen[r] ?? -1) !== gen) {
        pendingRows.add(r);
        needsRender = true;
      }
    }

    const cursor = cursorSnapshot(props.state.cursor);
    if (!lastCursor || cursorChanged(lastCursor, cursor)) {
      needsRender = true;
    }

    if (needsRender) scheduleRender();
  });

  onCleanup(() => {
    if (rafId !== undefined) {
      window.cancelAnimationFrame(rafId);
      rafId = undefined;
      props.onRenderCancelled?.();
    }
  });

  function queueAllRows(size: TerminalSize): void {
    pendingRows.clear();
    for (let r = 0; r < size.rows; r++) pendingRows.add(r);
  }

  function scheduleRender(): void {
    if (!rootRef || !metrics) return;
    if (rafId !== undefined) return;
    props.onRenderScheduled?.();
    rafId = window.requestAnimationFrame(flushRender);
  }

  function flushRender(): void {
    rafId = undefined;
    if (!rootRef || !metrics) return;

    const startedAt = performance.now();
    const size = props.state.size;
    syncDomSize(size);

    const rowsToDraw = [...pendingRows]
      .filter((row) => row >= 0 && row < size.rows)
      .sort((a, b) => a - b);
    pendingRows.clear();

    for (const r of rowsToDraw) {
      const row = props.grid[r];
      if (row) renderRow(r, row, size.cols);
    }
    lastDrawnGen.length = size.rows;
    lastRowSignatures.length = size.rows;

    renderCursorOverlay(props.state.cursor);
    lastCursor = cursorSnapshot(props.state.cursor);
    props.onRenderFrame?.(performance.now() - startedAt);
  }

  function syncDomSize(size: TerminalSize): boolean {
    if (!rootRef || !metrics) return false;
    const prev = lastSynced;
    if (
      prev &&
      prev.rows === size.rows &&
      prev.cols === size.cols &&
      prev.cellW === metrics.cellW &&
      prev.cellH === metrics.cellH &&
      prev.fontFamily === metrics.fontFamily &&
      prev.fontSize === metrics.fontSize &&
      prev.fixedPitch === metrics.fixedPitch
    ) {
      return false;
    }

    ensureRowElements(size.rows);
    const next = gridDomSize(size, metrics);
    Object.assign(rootRef.style, rootStyle(next, metrics));
    for (const row of rowElements) {
      Object.assign(row.style, rowStyle(next.cssW, metrics));
    }
    lastSynced = {
      rows: size.rows,
      cols: size.cols,
      cellW: metrics.cellW,
      cellH: metrics.cellH,
      fontFamily: metrics.fontFamily,
      fontSize: metrics.fontSize,
      fixedPitch: metrics.fixedPitch,
    };
    lastDrawnGen.length = 0;
    lastRowSignatures.length = 0;
    return true;
  }

  function ensureRowElements(rows: number): void {
    if (!rootRef) return;
    while (rowElements.length < rows) {
      const row = document.createElement("div");
      rootRef.insertBefore(row, cursorRef ?? null);
      rowElements.push(row);
    }
    while (rowElements.length > rows) {
      rowElements.pop()?.remove();
    }
  }

  function renderRow(rowIndex: number, cells: Cell[], cols: number): void {
    if (!metrics) return;
    const row = rowElements[rowIndex];
    if (!row) return;
    const segments = segmentsForGridRow(cells, cols);
    const signature = gridSegmentSignature(segments);
    if (lastRowSignatures[rowIndex] === signature) {
      lastDrawnGen[rowIndex] = props.state.rowGen[rowIndex] ?? 0;
      return;
    }

    const frag = document.createDocumentFragment();
    for (const seg of segments) {
      frag.appendChild(segmentElement(seg, metrics));
    }
    row.replaceChildren(frag);
    lastRowSignatures[rowIndex] = signature;
    lastDrawnGen[rowIndex] = props.state.rowGen[rowIndex] ?? 0;
  }

  function renderCursorOverlay(cursor: Cursor): void {
    if (!cursorRef || !metrics) return;
    if (!cursor.visible || cursor.style === "hidden") {
      cursorRef.style.display = "none";
      return;
    }
    const size = props.state.size;
    if (
      cursor.row < 0 ||
      cursor.row >= size.rows ||
      cursor.col < 0 ||
      cursor.col >= size.cols
    ) {
      cursorRef.style.display = "none";
      return;
    }

    const cell = props.grid[cursor.row]?.[cursor.col] ?? makeBlank();
    const model = cursorOverlayModel(cursor, cell, metrics);
    if (!model) {
      cursorRef.style.display = "none";
      return;
    }

    cursorRef.textContent = model.text;
    cursorRef.style.display = "block";
    cursorRef.style.transform = `translate(${model.x}px, ${model.y}px)`;
    cursorRef.style.width = `${model.width}px`;
    cursorRef.style.height = `${model.height}px`;
    cursorRef.style.marginTop = `${model.marginTop}px`;
    cursorRef.style.color = model.color;
    cursorRef.style.background = model.background;
    cursorRef.style.lineHeight = `${metrics.cellH}px`;
    cursorRef.style.fontFamily = metrics.fontFamily;
    cursorRef.style.fontSize = `${metrics.fontSize}px`;
  }

  return (
    <div ref={rootRef}>
      <div ref={cursorRef} style={cursorOverlayStyle()} />
    </div>
  );
};

export function segmentsForGridRow(
  cells: Cell[],
  cols: number,
): GridRowSegment[] {
  const out: GridRowSegment[] = [];
  const end = visibleEnd(cells, cols);
  let i = 0;
  while (i < end) {
    const cell = cellAt(cells, i);

    if (cell.width === "wide_spacer") {
      i++;
      continue;
    }

    if (cell.width === "wide") {
      const xCell = i;
      const fg = cell.fg;
      const bg = cell.bg;
      const attrs = cell.attrs;
      let text = glyphForCell(cell);
      let widthCells = 2;
      i++;

      while (i < end) {
        const spacer = cellAt(cells, i);
        const next = cellAt(cells, i + 1);
        if (spacer.width !== "wide_spacer") break;
        if (next.width !== "wide") break;
        if (!sameColor(fg, next.fg)) break;
        if (!sameColor(bg, next.bg)) break;
        if (!sameAttrs(attrs, next.attrs)) break;
        text += glyphForCell(next);
        widthCells += 2;
        i += 2;
      }

      if (cellAt(cells, i).width === "wide_spacer") i++;
      out.push({ xCell, text, fg, bg, attrs, widthCells });
      continue;
    }

    if (isSkippableBlank(cell)) {
      i++;
      continue;
    }

    if (isBoxDrawingCell(cell)) {
      const xCell = i;
      const fg = cell.fg;
      const bg = cell.bg;
      const attrs = cell.attrs;
      let text = cell.ch;
      let widthCells = 1;
      i++;

      while (i < end) {
        const next = cellAt(cells, i);
        if (!isBoxDrawingCell(next)) break;
        if (!sameColor(fg, next.fg)) break;
        if (!sameColor(bg, next.bg)) break;
        if (!sameAttrs(attrs, next.attrs)) break;
        text += next.ch;
        widthCells++;
        i++;
      }

      out.push({ xCell, text, fg, bg, attrs, widthCells });
      continue;
    }

    if (isBlockElementCell(cell)) {
      const xCell = i;
      const fg = cell.fg;
      const bg = cell.bg;
      const attrs = cell.attrs;
      let text = cell.ch;
      let widthCells = 1;
      i++;

      while (i < end) {
        const next = cellAt(cells, i);
        if (!isBlockElementCell(next)) break;
        if (!sameColor(fg, next.fg)) break;
        if (!sameColor(bg, next.bg)) break;
        if (!sameAttrs(attrs, next.attrs)) break;
        text += next.ch;
        widthCells++;
        i++;
      }

      out.push({ xCell, text, fg, bg, attrs, widthCells });
      continue;
    }

    const xCell = i;
    const fg = cell.fg;
    const bg = cell.bg;
    const attrs = cell.attrs;
    let text = glyphForCell(cell);
    let widthCells = 1;
    i++;

    while (i < end) {
      const next = cellAt(cells, i);
      if (next.width !== "single") break;
      if (isSkippableBlank(next)) break;
      if (isBoxDrawingCell(next) || isBlockElementCell(next)) break;
      if (!sameColor(fg, next.fg)) break;
      if (!sameColor(bg, next.bg)) break;
      if (!sameAttrs(attrs, next.attrs)) break;
      text += glyphForCell(next);
      widthCells++;
      i++;
    }

    out.push({ xCell, text, fg, bg, attrs, widthCells });
  }
  return out;
}

export function debugGridRowSegments(
  cells: Cell[],
  cols: number,
): GridRowDebugSegment[] {
  return segmentsForGridRow(cells, cols).map(({ xCell, widthCells, text }) => ({
    xCell,
    widthCells,
    text,
  }));
}

export function gridSegmentSignature(segments: GridRowSegment[]): string {
  return segments
    .map(
      (seg) =>
        `${seg.xCell}:${seg.widthCells}:${colorKey(seg.fg)}:${colorKey(seg.bg)}:${attrsKey(
          seg.attrs,
        )}:${seg.text}`,
    )
    .join("\x1f");
}

export function cursorOverlayModel(
  cursor: Cursor,
  cell: Cell,
  metrics: Pick<CellMetrics, "cellW" | "cellH">,
): CursorOverlayModel | null {
  if (!cursor.visible || cursor.style === "hidden") return null;

  const widthCells = cell.width === "wide" ? 2 : 1;
  const x = cursor.col * metrics.cellW;
  const y = cursor.row * metrics.cellH;

  if (cursor.style === "block") {
    return {
      x,
      y,
      width: widthCells * metrics.cellW,
      height: metrics.cellH,
      marginTop: 0,
      text: cell.attrs.includes("hidden") || cell.width === "wide_spacer"
        ? " "
        : glyphForCell(cell),
      color: colorToDomCss(cell.bg, "fg"),
      background: colorToDomCss(cell.fg, "bg"),
    };
  }

  if (cursor.style === "underline") {
    return {
      x,
      y,
      width: widthCells * metrics.cellW,
      height: 2,
      marginTop: metrics.cellH - 2,
      text: "",
      color: "transparent",
      background: "var(--term-cursor)",
    };
  }

  return {
    x,
    y,
    width: 2,
    height: metrics.cellH,
    marginTop: 0,
    text: "",
    color: "transparent",
    background: "var(--term-cursor)",
  };
}

function segmentElement(seg: GridRowSegment, metrics: CellMetrics): HTMLSpanElement {
  const span = document.createElement("span");
  Object.assign(span.style, {
    position: "absolute",
    left: `${seg.xCell * metrics.cellW}px`,
    top: "0",
    display: "inline-block",
    width: `${seg.widthCells * metrics.cellW}px`,
    height: `${metrics.cellH}px`,
    lineHeight: `${metrics.cellH}px`,
    overflow: "hidden",
    verticalAlign: "top",
    whiteSpace: "pre",
  });
  const css = segmentStyle(seg);
  // CSS bold can pick a different font face with a different advance in WebKitGTK.
  // The active grid is positioned by terminal cells, so color may change but glyph
  // weight must not change layout.
  delete css["font-weight"];
  if (seg.attrs.includes("hidden")) {
    delete css.visibility;
    css.color = "transparent";
  }
  for (const [key, value] of Object.entries(css)) {
    span.style.setProperty(key, value);
  }
  if (isBoxDrawingRun(seg.text)) {
    renderBoxDrawingRun(span, seg.text, metrics);
  } else if (isBlockElementRun(seg.text)) {
    renderBlockElementRun(span, seg.text, metrics);
  } else if (!metrics.fixedPitch) {
    renderCellDistributedTextRun(span, seg.text, seg.widthCells, metrics);
  } else {
    span.textContent = seg.text;
  }
  return span;
}

export function terminalTextClusters(text: string): string[] {
  const clusters: string[] = [];
  for (const ch of text) {
    if (isCombiningMark(ch) && clusters.length > 0) {
      clusters[clusters.length - 1] += ch;
    } else {
      clusters.push(ch);
    }
  }
  return clusters;
}

function isCombiningMark(ch: string): boolean {
  return /\p{Mark}/u.test(ch);
}

function renderCellDistributedTextRun(
  span: HTMLSpanElement,
  text: string,
  widthCells: number,
  metrics: CellMetrics,
): void {
  const clusters = terminalTextClusters(text);
  if (clusters.length === 0) return;

  const frag = document.createDocumentFragment();
  const cellsPerCluster = widthCells / clusters.length;
  clusters.forEach((cluster, index) => {
    const glyph = document.createElement("span");
    Object.assign(glyph.style, {
      position: "absolute",
      left: `${index * cellsPerCluster * metrics.cellW}px`,
      top: "0",
      display: "inline-block",
      width: `${cellsPerCluster * metrics.cellW}px`,
      height: `${metrics.cellH}px`,
      lineHeight: `${metrics.cellH}px`,
      overflow: "hidden",
      whiteSpace: "pre",
    });
    glyph.textContent = cluster;
    frag.appendChild(glyph);
  });
  span.replaceChildren(frag);
}

function renderBlockElementRun(
  span: HTMLSpanElement,
  text: string,
  metrics: CellMetrics,
): void {
  const frag = document.createDocumentFragment();
  [...text].forEach((ch, index) => {
    const model = blockElementModel(ch);
    if (!model) return;
    const cellLeft = index * metrics.cellW;
    for (const rect of model.rects) {
      const block = document.createElement("span");
      Object.assign(block.style, {
        position: "absolute",
        left: `${cellLeft + rect.x * metrics.cellW}px`,
        top: `${rect.y * metrics.cellH}px`,
        width: `${rect.w * metrics.cellW}px`,
        height: `${rect.h * metrics.cellH}px`,
        display: "block",
        background: "currentColor",
        pointerEvents: "none",
      });
      frag.appendChild(block);
    }
  });
  span.replaceChildren(frag);
}

function renderBoxDrawingRun(
  span: HTMLSpanElement,
  text: string,
  metrics: CellMetrics,
): void {
  const frag = document.createDocumentFragment();
  [...text].forEach((ch, index) => {
    const model = boxDrawingModel(ch);
    if (!model) return;
    for (const stem of model.stems) {
      frag.appendChild(boxDrawingStemElement(stem, model.weight, metrics, index));
    }
  });
  span.replaceChildren(frag);
}

function boxDrawingStemElement(
  stem: BoxDrawingStem,
  weight: BoxDrawingWeight,
  metrics: CellMetrics,
  cellIndex: number,
): HTMLSpanElement {
  const line = document.createElement("span");
  const rect = boxDrawingStemRect(stem, weight, metrics, cellIndex);
  Object.assign(line.style, {
    position: "absolute",
    display: "block",
    background: "currentColor",
    pointerEvents: "none",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
  return line;
}

function visibleEnd(
  cells: Cell[],
  cols: number,
): number {
  let end = cols;
  while (end > 0) {
    if (!isSkippableBlank(cellAt(cells, end - 1))) break;
    end--;
  }
  return end;
}

function glyphForCell(cell: Cell): string {
  return cell.combining.length > 0 ? cell.ch + cell.combining.join("") : cell.ch;
}

function isBoxDrawingCell(cell: Cell): boolean {
  return (
    cell.width === "single" &&
    cell.combining.length === 0 &&
    isBoxDrawingGlyph(cell.ch)
  );
}

function isBlockElementCell(cell: Cell): boolean {
  return (
    cell.width === "single" &&
    cell.combining.length === 0 &&
    isBlockElementGlyph(cell.ch)
  );
}

function cellAt(cells: Cell[], index: number): Cell {
  return cells[index] ?? makeBlank();
}

function makeBlank(): Cell {
  return {
    ch: " ",
    combining: [],
    width: "single",
    fg: DEFAULT_FG,
    bg: DEFAULT_BG,
    attrs: [],
  };
}

function cursorSnapshot(cursor: Cursor): Cursor {
  return {
    row: cursor.row,
    col: cursor.col,
    visible: cursor.visible,
    style: cursor.style,
  };
}

function cursorChanged(a: Cursor, b: Cursor): boolean {
  return (
    a.row !== b.row ||
    a.col !== b.col ||
    a.visible !== b.visible ||
    a.style !== b.style
  );
}

function isSkippableBlank(c: Cell): boolean {
  return (
    c.ch === " " &&
    c.combining.length === 0 &&
    c.width === "single" &&
    sameColor(c.bg, DEFAULT_BG) &&
    !c.attrs.includes("reverse") &&
    !c.attrs.includes("underline") &&
    !c.attrs.includes("strikethrough")
  );
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

function sameAttrs(a: CellAttr[], b: CellAttr[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function colorKey(c: Color): string {
  if ("named" in c) return "n" + c.named;
  if ("rgb" in c) return `r${c.rgb.r},${c.rgb.g},${c.rgb.b}`;
  return "i" + c.indexed;
}

function attrsKey(a: CellAttr[]): string {
  if (a.length === 0) return "";
  if (a.length === 1) return a[0];
  return a.join(",");
}

function rootStyle(size: GridDomSize, metrics: CellMetrics): Record<string, string> {
  return {
    position: "relative",
    display: "block",
    width: `${size.cssW}px`,
    height: `${size.cssH}px`,
    fontFamily: metrics.fontFamily,
    fontSize: `${metrics.fontSize}px`,
    lineHeight: `${metrics.cellH}px`,
    whiteSpace: "pre",
    letterSpacing: "0",
    fontVariantLigatures: "none",
    userSelect: "none",
    webkitUserSelect: "none",
    contain: "layout paint style",
  };
}

function rowStyle(width: number, metrics: CellMetrics): Record<string, string> {
  return {
    position: "relative",
    width: `${width}px`,
    height: `${metrics.cellH}px`,
    lineHeight: `${metrics.cellH}px`,
    overflow: "hidden",
    whiteSpace: "pre",
    contain: "layout paint style",
  };
}

function cursorOverlayStyle(): Record<string, string> {
  return {
    position: "absolute",
    left: "0",
    top: "0",
    display: "none",
    "pointer-events": "none",
    "z-index": "1",
    overflow: "hidden",
    "white-space": "pre",
    "letter-spacing": "0",
    "font-variant-ligatures": "none",
  };
}
