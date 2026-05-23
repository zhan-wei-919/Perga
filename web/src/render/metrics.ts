// Cell 字体度量。
//
// 终端的核心几何就是 cellW / cellH:rows/cols 由容器尺寸除得到,DOM grid 与
// 历史行用同一份度量保持视觉一致。
//
// 测度方式:在 body 下挂一个 hidden span,用 `getBoundingClientRect()` 而不是
// `canvas.measureText`。原因是 canvas measureText 在不同浏览器对 line-height
// 处理不一致,getBoundingClientRect 给的是真实布局尺寸。

/// 终端字体栈。活动区与历史区共用,保证视觉一致。
export const FONT_FAMILY =
  '"DejaVu Sans Mono", "Liberation Mono", "Cascadia Mono", "Cascadia Code", "JetBrains Mono", "Fira Code", Menlo, Consolas, monospace';

export type CellMetrics = {
  /** Cell 宽度(CSS 像素)。一个单宽 ASCII char 占的水平距离。 */
  cellW: number;
  /** Cell 高度(CSS 像素)= line-height。 */
  cellH: number;
  /** baseline 到 cell top 的距离(用于 fillText 定位)。 */
  baseline: number;
  /** 度量时用的 font-family,fillStyle 阶段要重复设置。 */
  fontFamily: string;
  /** 度量时用的 font-size(CSS 像素)。 */
  fontSize: number;
};

const PROBE_LEN = 100;

/// 测量给定字体的 cell 尺寸。同步,代价 ~1 帧 reflow。
///
/// 调用时机:
/// - 首次挂载终端时一次。
/// - 用户改字体 / 改 zoom 时重测。
/// - 设备 DPR 变化(从笔记本移到外接屏)── ResizeObserver 自然会触发后续 resize。
export function measureCell(fontFamily: string, fontSize: number): CellMetrics {
  // line-height 选 1.3 是 monospace 字体的常见比例,留够 underline / 下划线
  // 不被裁掉。整数化是为了避免 sub-pixel 累积误差让网格变形。
  const lineHeight = Math.round(fontSize * 1.3);

  const probe = document.createElement("span");
  probe.style.position = "fixed";
  probe.style.top = "-1000px";
  probe.style.left = "0";
  probe.style.visibility = "hidden";
  probe.style.fontFamily = fontFamily;
  probe.style.fontSize = `${fontSize}px`;
  probe.style.lineHeight = `${lineHeight}px`;
  probe.style.whiteSpace = "pre";
  probe.style.fontVariantLigatures = "none";
  // 单元格宽度必须由 Latin monospace 决定。CJK fallback 偏宽时不能反过来
  // 放大全部 ASCII cell,否则 prompt / ls 列 / 光标都会漂。
  // 用 'M' 而不是 'a':宽度更稳定(部分字体的 'a' 比平均值窄)。
  probe.textContent = "M".repeat(PROBE_LEN);
  document.body.appendChild(probe);
  const latinRect = probe.getBoundingClientRect();
  document.body.removeChild(probe);

  // baseline = fontSize * 0.8 是大多数 monospace 字体的近似 ascent。
  // 精确值要去解析字体 metrics(canvas measureText 的 alphabeticBaseline
  // 给得不全),Phase 1 用近似,够看就行。
  return {
    cellW: measuredCellWidth(latinRect.width, PROBE_LEN),
    cellH: lineHeight,
    baseline: Math.round(fontSize * 0.82),
    fontFamily,
    fontSize,
  };
}

export function measuredCellWidth(
  latinWidth: number,
  latinCount: number,
): number {
  return latinWidth / latinCount;
}

/// 一个像素盒子能装下多少 cell(rows × cols)。
///
/// floor:cells 必须填得下,半 cell 不画。最小 1 是给 alacritty / PTY 一个合法值
/// ── 0 行 0 列会让 alacritty 算子里 div by zero。
///
/// 初始 connect(`pane_leaf`)与 resize 上报(`resize.ts`)共用这一份定义,
/// 避免「容器尺寸 → 网格」公式漂移。
export function cellsForBox(
  box: { width: number; height: number },
  m: Pick<CellMetrics, "cellW" | "cellH">,
): { rows: number; cols: number } {
  return {
    rows: Math.max(1, Math.floor(box.height / m.cellH)),
    cols: Math.max(1, Math.floor(box.width / m.cellW)),
  };
}
