// Canvas Grid 渲染器。
//
// 性能关键路径,设计要点:
//
// 1. **run-grouping**:同 `(fg, bg, attrs)` 的连续单宽 cell 合成一段 run,
//    一次 fillRect 画背景 + 一次 fillText 画字符。
//
// 2. **style 缓存**:`ctx.fillStyle` / `ctx.font` 的 setter 比一次 fillRect
//    还贵(浏览器要解析字符串)。同值不重设。
//
// 3. **dirty-row 增量 + RAF 合批**:Solid effect 只订阅 `state.rowGen[r]`
//    和 cursor,把脏行合并到下一帧 RAF 里统一绘制。
//
// 4. **cursor 单独绘制**:cursor 跨行移动时,原位置行的 rowGen 不一定 +1
//    (无字符变化),所以单独跟踪 cursor 信号。
//
// 5. **DPR-aware**:canvas 内部分辨率乘以 devicePixelRatio,显示尺寸维持
//    CSS 像素;`setTransform(dpr, ...)` 后续绘图坐标全用 CSS 像素。
//
// 6. **raw grid**:grid 不进入 Solid store。renderer 通过 rowGen 响应式信号
//    得知哪几行变了,绘制时读取普通 Cell[][],避开 store proxy trap。
//
// 7. **activeTop 裁剪**:只渲染 [activeTop, rows) ── [0, activeTop) 的内容
//    已被命令块(DOM)收走。activeTop 变化会改 backing size,自然触发整屏
//    重画;grid 行 r 画在显示行 r - activeTop。

import { Component, createEffect, onCleanup, onMount } from "solid-js";

import type { Cell, CellAttr, Color, Cursor, TerminalSize } from "../state/protocol";
import { DEFAULT_BG, DEFAULT_FG } from "../state/protocol";
import type { SessionViewState } from "../state/session";
import { CellMetrics, measureCell } from "./metrics";
import { colorToCss } from "./palette";

const FONT_FAMILY =
  'ui-monospace, "Cascadia Code", "JetBrains Mono", "Fira Code", Menlo, Consolas, monospace';

export type GridCanvasProps = {
  state: SessionViewState;
  grid: Cell[][];
  /** CSS 像素的 font-size。Phase 1 固定 14,Phase 4 接 zoom 后由父组件传入。 */
  fontSize?: number;
  onRenderScheduled?: () => void;
  onRenderFrame?: (durationMs: number) => void;
  /** 已 scheduled 的 RAF 在 flush 前被取消(组件卸载)。与 onRenderScheduled
   *  配对,让下游 pending 计数不泄漏。 */
  onRenderCancelled?: () => void;
};

export type CanvasBackingSize = {
  cssW: number;
  cssH: number;
  pixelW: number;
  pixelH: number;
};

export function canvasBackingSize(
  size: TerminalSize,
  metrics: Pick<CellMetrics, "cellW" | "cellH">,
  ratio: number,
  activeTop: number,
): CanvasBackingSize {
  // Canvas 只画活动区 [activeTop, rows);[0, activeTop) 归命令块。
  const visibleRows = Math.max(0, size.rows - activeTop);
  const cssW = size.cols * metrics.cellW;
  const cssH = visibleRows * metrics.cellH;
  return {
    cssW,
    cssH,
    pixelW: Math.round(cssW * ratio),
    pixelH: Math.round(cssH * ratio),
  };
}

export function canvasBackingSizeMatches(
  canvas: Pick<HTMLCanvasElement, "width" | "height">,
  target: CanvasBackingSize,
): boolean {
  return canvas.width === target.pixelW && canvas.height === target.pixelH;
}

/** 跨 drawRow 调用复用的 canvas 状态缓存,避免重复 setter。 */
type DrawCache = {
  lastFillStyle: string;
  lastFont: string;
};

function newDrawCache(): DrawCache {
  return { lastFillStyle: "", lastFont: "" };
}

function setFillStyle(
  ctx: CanvasRenderingContext2D,
  cache: DrawCache,
  css: string,
): void {
  if (cache.lastFillStyle !== css) {
    ctx.fillStyle = css;
    cache.lastFillStyle = css;
  }
}

function setFont(
  ctx: CanvasRenderingContext2D,
  cache: DrawCache,
  font: string,
): void {
  if (cache.lastFont !== font) {
    ctx.font = font;
    cache.lastFont = font;
  }
}

export const GridCanvas: Component<GridCanvasProps> = (props) => {
  let canvasRef: HTMLCanvasElement | undefined;
  let metrics: CellMetrics | undefined;
  let ctx: CanvasRenderingContext2D | undefined;
  const lastDrawnGen: number[] = [];
  const pendingRows = new Set<number>();
  let lastCursor: Cursor | undefined;
  // 上一帧画时用的 activeTop。它一变,grid 行 → 显示行的映射就整体偏移,
  // 必须整屏重画 —— 不能只靠 backing size 判定(rows 与 activeTop 同时变、
  // 差值不变时 backing size 不变,但映射已经变了)。
  let lastActiveTop = -1;
  let rafId: number | undefined;
  const drawCache = newDrawCache();

  onMount(() => {
    if (!canvasRef) return;
    const c = canvasRef.getContext("2d");
    if (!c) {
      // 浏览器不支持 2d canvas —— 极小概率,但要么 fail-loud 要么 fallback。
      // Phase 1 fail-loud 让 bug 早暴露(CLAUDE.md §不过度兜底)。
      throw new Error("canvas 2d context not available");
    }
    ctx = c;
    metrics = measureCell(FONT_FAMILY, props.fontSize ?? 14);
    syncCanvasSize();
    queueAllRows(props.state.size);
    scheduleRender();
  });

  // Solid effect 只负责收集变化;实际 canvas 绘制合并到 RAF。
  createEffect(() => {
    if (!ctx || !metrics || !canvasRef) return;

    let needsRender = false;
    const size = props.state.size;
    const activeTop = props.state.activeTop;
    const target = canvasBackingSize(size, metrics, dpr(), activeTop);
    if (!canvasBackingSizeMatches(canvasRef, target) || activeTop !== lastActiveTop) {
      lastDrawnGen.length = 0;
      lastCursor = undefined;
      queueAllRows(size);
      needsRender = true;
    }

    // 只看活动区的行;[0, activeTop) 归命令块,它们的 rowGen 即使变了也不画。
    for (let r = activeTop; r < size.rows; r++) {
      const gen = props.state.rowGen[r] ?? 0;
      const last = lastDrawnGen[r] ?? -1;
      if (gen !== last) {
        pendingRows.add(r);
        needsRender = true;
      }
    }

    const cursor = props.state.cursor;
    const cursorSnapshot = {
      row: cursor.row,
      col: cursor.col,
      visible: cursor.visible,
      style: cursor.style,
    };
    if (!lastCursor || cursorChanged(lastCursor, cursorSnapshot)) {
      needsRender = true;
    }

    if (needsRender) scheduleRender();
  });

  // DPR 变化(主屏换显示器)时触发 resize ── 浏览器没有可靠的 dpr change
  // event,这里通过 matchMedia 监听 resolution 变化。
  onMount(() => {
    const mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const handler = (): void => {
      lastDrawnGen.length = 0;
      lastCursor = undefined;
      queueAllRows(props.state.size);
      scheduleRender();
    };
    mql.addEventListener("change", handler);
    onCleanup(() => mql.removeEventListener("change", handler));
  });

  onCleanup(() => {
    if (rafId !== undefined) {
      // 已 onRenderScheduled 但 RAF 还没 flush ── 取消并通知,否则下游
      // (autotest)的 pending 计数会泄漏:scheduled 永远等不到配对的 frame。
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
    if (!ctx || !metrics || !canvasRef) return;
    if (rafId !== undefined) return;
    props.onRenderScheduled?.();
    rafId = window.requestAnimationFrame(flushRender);
  }

  function flushRender(): void {
    rafId = undefined;
    if (!ctx || !metrics || !canvasRef) return;

    const startedAt = performance.now();
    const size = props.state.size;
    const activeTop = props.state.activeTop;
    const target = canvasBackingSize(size, metrics, dpr(), activeTop);
    if (!canvasBackingSizeMatches(canvasRef, target) || activeTop !== lastActiveTop) {
      syncCanvasSize(target);
      lastDrawnGen.length = 0;
      lastCursor = undefined;
      queueAllRows(size);
    }
    lastActiveTop = activeTop;

    const rowsToDraw = [...pendingRows]
      .filter((row) => row >= activeTop && row < size.rows)
      .sort((a, b) => a - b);
    pendingRows.clear();

    const drawnRows = new Set<number>();
    for (const r of rowsToDraw) {
      const row = props.grid[r];
      if (row) {
        drawRow(ctx, metrics, drawCache, r - activeTop, row, size.cols);
      }
      lastDrawnGen[r] = props.state.rowGen[r] ?? 0;
      drawnRows.add(r);
    }
    lastDrawnGen.length = size.rows;

    drawCursor(ctx, metrics, drawnRows, activeTop);
    props.onRenderFrame?.(performance.now() - startedAt);
  }

  function drawCursor(
    ctx: CanvasRenderingContext2D,
    metrics: CellMetrics,
    drawnRows: Set<number>,
    activeTop: number,
  ): void {
    const cursor = props.state.cursor;
    if (lastCursor?.visible && cursorChanged(lastCursor, cursor)) {
      const row = props.grid[lastCursor.row];
      const displayRow = lastCursor.row - activeTop;
      if (row && displayRow >= 0 && !drawnRows.has(lastCursor.row)) {
        const cell = row[lastCursor.col];
        if (cell) {
          drawSingleCell(ctx, metrics, drawCache, displayRow, lastCursor.col, cell, false);
        }
      }
    }
    if (cursor.visible) {
      const row = props.grid[cursor.row];
      const displayRow = cursor.row - activeTop;
      // 光标落在命令块区(displayRow < 0)就不画 ── 它不在 Canvas 里。
      if (row && displayRow >= 0) {
        const cell = row[cursor.col] ?? makeBlank();
        drawSingleCell(ctx, metrics, drawCache, displayRow, cursor.col, cell, true);
      }
    }
    lastCursor = { ...cursor };
  }

  function syncCanvasSize(target?: CanvasBackingSize): void {
    if (!canvasRef || !metrics) return;
    const next =
      target ??
      canvasBackingSize(props.state.size, metrics, dpr(), props.state.activeTop);
    const ratio = dpr();
    canvasRef.width = next.pixelW;
    canvasRef.height = next.pixelH;
    canvasRef.style.width = `${next.cssW}px`;
    canvasRef.style.height = `${next.cssH}px`;
    if (ctx) {
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.textBaseline = "alphabetic";
      // 重置缓存:transform 重置后 canvas 全局 state(font / fillStyle)语义
      // 不一定保留,保守起见清空。
      drawCache.lastFillStyle = "";
      drawCache.lastFont = "";
      setFillStyle(ctx, drawCache, colorToCss(DEFAULT_BG, "bg"));
      ctx.fillRect(0, 0, next.cssW, next.cssH);
    }
  }

  // display:block ── 去掉 <canvas> 作为 inline 元素时下方的基线空隙。
  return <canvas ref={canvasRef} style={{ display: "block" }} />;
};

function cursorChanged(a: Cursor, b: Cursor): boolean {
  return (
    a.row !== b.row ||
    a.col !== b.col ||
    a.visible !== b.visible ||
    a.style !== b.style
  );
}

function dpr(): number {
  return window.devicePixelRatio || 1;
}

/**
 * 把一行 cell 分成「相同 style 的连续段」并各自合批画。
 *
 * 一段 run = `[start, end)` 内所有 cell 满足:
 *   - 单宽(`width === "single"`)── wide 和 spacer 不参与 run-grouping,各自走单独路径
 *   - 同 fg / bg / attrs
 *
 * 每段 run 用两个 canvas op 画完:
 *   1. `fillRect` 一次画 bg(整段)
 *   2. `fillText` 一次画 fg + 字符串(整段拼接)
 *
 * 加上同段内 lastFillStyle / lastFont 缓存,典型 80 列行从 ~400 canvas ops
 * 降到 ~6-12 ops。
 */
function drawRow(
  ctx: CanvasRenderingContext2D,
  m: CellMetrics,
  cache: DrawCache,
  displayRow: number,
  cells: Cell[],
  cols: number,
): void {
  const y = displayRow * m.cellH;
  let i = 0;
  while (i < cols && i < cells.length) {
    const cell = cells[i];

    if (cell.width === "wide_spacer") {
      // spacer 由它前面的 wide 主格统一处理;独立 spacer(异常情况)什么都不画。
      i++;
      continue;
    }

    if (cell.width === "wide") {
      drawSingleCell(ctx, m, cache, displayRow, i, cell, false);
      i++;
      continue;
    }

    // 单宽 run 起点:扫到下一个不同 style / 非单宽的 cell。
    const refFg = cell.fg;
    const refBg = cell.bg;
    const refAttrs = cell.attrs;
    const refFgKey = colorKey(refFg);
    const refBgKey = colorKey(refBg);
    const refAttrsKey = attrsKey(refAttrs);

    let end = i + 1;
    while (end < cols && end < cells.length) {
      const c = cells[end];
      if (c.width !== "single") break;
      if (colorKey(c.fg) !== refFgKey) break;
      if (colorKey(c.bg) !== refBgKey) break;
      if (attrsKey(c.attrs) !== refAttrsKey) break;
      end++;
    }

    paintRun(ctx, m, cache, i, end, cells, refFg, refBg, refAttrs, y);
    i = end;
  }
}

function paintRun(
  ctx: CanvasRenderingContext2D,
  m: CellMetrics,
  cache: DrawCache,
  start: number,
  end: number,
  cells: Cell[],
  fg: Color,
  bg: Color,
  attrs: CellAttr[],
  y: number,
): void {
  const isReverse = attrs.includes("reverse");
  const effFg = isReverse ? bg : fg;
  const effBg = isReverse ? fg : bg;

  const x = start * m.cellW;
  const w = (end - start) * m.cellW;

  // bg
  setFillStyle(ctx, cache, colorToCss(effBg, "bg"));
  ctx.fillRect(x, y, w, m.cellH);

  if (attrs.includes("hidden")) return;

  // text:把整段的 ch 拼成字符串。combining 出现的概率极低,有 combining
  // 的 cell 实际走 RowEntry::Cells → 那条路径下 cell.width 仍是 single,
  // 但 cells[i].combining 不空时落不进 run-grouping —— 因为 sameStyle 比的
  // 是 attrs,combining 不参与判定。所以这里需要 join combining。
  // 性能影响:99% 文本流没有 combining,join 空数组成本几乎为零。
  let text = "";
  for (let j = start; j < end; j++) {
    const c = cells[j];
    text += c.ch;
    if (c.combining.length > 0) {
      for (const cc of c.combining) text += cc;
    }
  }

  setFillStyle(ctx, cache, colorToCss(effFg, "fg"));
  setFont(ctx, cache, fontFor(attrs, m));
  ctx.fillText(text, x, y + m.baseline);

  if (attrs.includes("underline")) {
    setFillStyle(ctx, cache, colorToCss(effFg, "fg"));
    ctx.fillRect(x, y + m.baseline + 2, w, 1);
  }
  if (attrs.includes("strikethrough")) {
    setFillStyle(ctx, cache, colorToCss(effFg, "fg"));
    ctx.fillRect(x, y + Math.round(m.cellH / 2), w, 1);
  }
}

/// 用于 wide char、cursor、wide spacer 的快速回退:单 cell 自己画自己。
/// 不进 run-grouping 的少数路径。
function drawSingleCell(
  ctx: CanvasRenderingContext2D,
  m: CellMetrics,
  cache: DrawCache,
  displayRow: number,
  col: number,
  cell: Cell,
  isCursor: boolean,
): void {
  const x = col * m.cellW;
  const y = displayRow * m.cellH;
  const w = cell.width === "wide" ? m.cellW * 2 : m.cellW;

  const reverse = isCursor || cell.attrs.includes("reverse");
  const fg = reverse ? cell.bg : cell.fg;
  const bg = reverse ? cell.fg : cell.bg;

  setFillStyle(ctx, cache, colorToCss(bg, "bg"));
  ctx.fillRect(x, y, w, m.cellH);

  if (cell.width === "wide_spacer") return;
  if (cell.attrs.includes("hidden")) return;

  setFillStyle(ctx, cache, colorToCss(fg, "fg"));
  setFont(ctx, cache, fontFor(cell.attrs, m));

  const text =
    cell.combining.length > 0 ? cell.ch + cell.combining.join("") : cell.ch;
  ctx.fillText(text, x, y + m.baseline);

  if (cell.attrs.includes("underline")) {
    ctx.fillRect(x, y + m.baseline + 2, w, 1);
  }
  if (cell.attrs.includes("strikethrough")) {
    ctx.fillRect(x, y + Math.round(m.cellH / 2), w, 1);
  }
}

/// `Color` 的可比较短键。直接 JSON.stringify 会反复分配字符串;手写避开。
function colorKey(c: Color): string {
  if ("named" in c) return "n" + c.named;
  if ("rgb" in c) return `r${c.rgb.r},${c.rgb.g},${c.rgb.b}`;
  return "i" + c.indexed;
}

/// `attrs` 是排序无关的属性集,但实际来源(后端 RLE encoder)总是按 bitflag
/// 位序输出 ── 直接拼 join 比较即可,不需要排序成本。
function attrsKey(a: CellAttr[]): string {
  if (a.length === 0) return "";
  if (a.length === 1) return a[0];
  return a.join(",");
}

function fontFor(attrs: CellAttr[], m: CellMetrics): string {
  const weight = attrs.includes("bold") ? "bold" : "normal";
  const style = attrs.includes("italic") ? "italic" : "normal";
  return `${style} ${weight} ${m.fontSize}px ${m.fontFamily}`;
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
