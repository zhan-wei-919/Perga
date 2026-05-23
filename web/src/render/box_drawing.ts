// Unicode box drawing 字符的 cell 内矢量模型。
//
// 浏览器字体栈不会保证 box drawing glyph 贴满 terminal cell:line-height
// 留出的 leading 会让竖线断开,不同 fallback 字体的 advance 也会让格线漂移。
// 活动区 grid 对这些字符走 DOM 线段渲染,坐标仍由 terminal cell 决定。

export type BoxDrawingStem = "up" | "right" | "down" | "left";

export type BoxDrawingWeight = "light" | "heavy";

export type BoxDrawingModel = {
  stems: readonly BoxDrawingStem[];
  weight: BoxDrawingWeight;
};

export type BoxDrawingCellMetrics = {
  cellW: number;
  cellH: number;
  fontSize: number;
};

export type BoxDrawingStemRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

const SEAM_OVERLAP_PX = 1;

const LIGHT: Record<string, readonly BoxDrawingStem[]> = {
  "─": ["left", "right"],
  "│": ["up", "down"],
  "┌": ["right", "down"],
  "┐": ["left", "down"],
  "└": ["right", "up"],
  "┘": ["left", "up"],
  "├": ["up", "down", "right"],
  "┤": ["up", "down", "left"],
  "┬": ["left", "right", "down"],
  "┴": ["left", "right", "up"],
  "┼": ["left", "right", "up", "down"],
  "╭": ["right", "down"],
  "╮": ["left", "down"],
  "╰": ["right", "up"],
  "╯": ["left", "up"],
  "╶": ["right"],
  "╴": ["left"],
  "╷": ["down"],
  "╵": ["up"],
};

const HEAVY: Record<string, readonly BoxDrawingStem[]> = {
  "━": ["left", "right"],
  "┃": ["up", "down"],
  "┏": ["right", "down"],
  "┓": ["left", "down"],
  "┗": ["right", "up"],
  "┛": ["left", "up"],
  "┣": ["up", "down", "right"],
  "┫": ["up", "down", "left"],
  "┳": ["left", "right", "down"],
  "┻": ["left", "right", "up"],
  "╋": ["left", "right", "up", "down"],
};

export function boxDrawingModel(ch: string): BoxDrawingModel | null {
  const light = LIGHT[ch];
  if (light) return { stems: light, weight: "light" };
  const heavy = HEAVY[ch];
  if (heavy) return { stems: heavy, weight: "heavy" };
  return null;
}

export function isBoxDrawingGlyph(ch: string): boolean {
  return boxDrawingModel(ch) !== null;
}

export function isBoxDrawingRun(text: string): boolean {
  const chars = [...text];
  return chars.length > 0 && chars.every(isBoxDrawingGlyph);
}

export function boxDrawingStemRect(
  stem: BoxDrawingStem,
  weight: BoxDrawingWeight,
  metrics: BoxDrawingCellMetrics,
  cellIndex: number,
): BoxDrawingStemRect {
  const thickness = boxDrawingThickness(weight, metrics.fontSize);
  const half = thickness / 2;
  const cellLeft = cellIndex * metrics.cellW;

  if (stem === "left") {
    const left = cellLeft - SEAM_OVERLAP_PX;
    const right = cellLeft + metrics.cellW / 2 + half;
    return {
      left,
      top: metrics.cellH / 2 - half,
      width: right - left,
      height: thickness,
    };
  }

  if (stem === "right") {
    const left = cellLeft + metrics.cellW / 2 - half;
    const right = cellLeft + metrics.cellW + SEAM_OVERLAP_PX;
    return {
      left,
      top: metrics.cellH / 2 - half,
      width: right - left,
      height: thickness,
    };
  }

  if (stem === "up") {
    const top = -SEAM_OVERLAP_PX;
    const bottom = metrics.cellH / 2 + half;
    return {
      left: cellLeft + metrics.cellW / 2 - half,
      top,
      width: thickness,
      height: bottom - top,
    };
  }

  const top = metrics.cellH / 2 - half;
  const bottom = metrics.cellH + SEAM_OVERLAP_PX;
  return {
    left: cellLeft + metrics.cellW / 2 - half,
    top,
    width: thickness,
    height: bottom - top,
  };
}

export function boxDrawingThickness(
  weight: BoxDrawingWeight,
  fontSize: number,
): number {
  if (weight === "heavy") return Math.max(2, Math.round(fontSize / 8));
  return Math.max(1, Math.round(fontSize / 12));
}
