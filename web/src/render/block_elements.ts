// Unicode block elements 的 cell 内矩形模型。
//
// `▀` / `▄` / `█` 等字符常被 TUI 当作像素画。浏览器按字体 glyph 渲染时
// 会留下 anti-alias / leading 缝隙,这里改成用 fg 色填充精确 cell 矩形。

export type BlockElementRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type BlockElementModel = {
  rects: readonly BlockElementRect[];
};

const FULL: readonly BlockElementRect[] = [{ x: 0, y: 0, w: 1, h: 1 }];

const MODELS: Record<string, BlockElementModel> = {
  "█": { rects: FULL },
  "▀": { rects: [{ x: 0, y: 0, w: 1, h: 0.5 }] },
  "▄": { rects: [{ x: 0, y: 0.5, w: 1, h: 0.5 }] },
  "▌": { rects: [{ x: 0, y: 0, w: 0.5, h: 1 }] },
  "▐": { rects: [{ x: 0.5, y: 0, w: 0.5, h: 1 }] },
  "▔": { rects: [{ x: 0, y: 0, w: 1, h: 0.125 }] },
  "▁": { rects: [{ x: 0, y: 0.875, w: 1, h: 0.125 }] },
  "▂": { rects: [{ x: 0, y: 0.75, w: 1, h: 0.25 }] },
  "▃": { rects: [{ x: 0, y: 0.625, w: 1, h: 0.375 }] },
  "▅": { rects: [{ x: 0, y: 0.375, w: 1, h: 0.625 }] },
  "▆": { rects: [{ x: 0, y: 0.25, w: 1, h: 0.75 }] },
  "▇": { rects: [{ x: 0, y: 0.125, w: 1, h: 0.875 }] },
  "▏": { rects: [{ x: 0, y: 0, w: 0.125, h: 1 }] },
  "▎": { rects: [{ x: 0, y: 0, w: 0.25, h: 1 }] },
  "▍": { rects: [{ x: 0, y: 0, w: 0.375, h: 1 }] },
  "▋": { rects: [{ x: 0, y: 0, w: 0.625, h: 1 }] },
  "▊": { rects: [{ x: 0, y: 0, w: 0.75, h: 1 }] },
  "▉": { rects: [{ x: 0, y: 0, w: 0.875, h: 1 }] },
  "▖": { rects: [{ x: 0, y: 0.5, w: 0.5, h: 0.5 }] },
  "▗": { rects: [{ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }] },
  "▘": { rects: [{ x: 0, y: 0, w: 0.5, h: 0.5 }] },
  "▝": { rects: [{ x: 0.5, y: 0, w: 0.5, h: 0.5 }] },
  "▙": {
    rects: [
      { x: 0, y: 0, w: 0.5, h: 1 },
      { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    ],
  },
  "▚": {
    rects: [
      { x: 0, y: 0, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    ],
  },
  "▞": {
    rects: [
      { x: 0.5, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0.5, w: 0.5, h: 0.5 },
    ],
  },
  "▛": {
    rects: [
      { x: 0, y: 0, w: 1, h: 0.5 },
      { x: 0, y: 0.5, w: 0.5, h: 0.5 },
    ],
  },
  "▜": {
    rects: [
      { x: 0, y: 0, w: 1, h: 0.5 },
      { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    ],
  },
  "▟": {
    rects: [
      { x: 0, y: 0.5, w: 1, h: 0.5 },
      { x: 0.5, y: 0, w: 0.5, h: 0.5 },
    ],
  },
};

export function blockElementModel(ch: string): BlockElementModel | null {
  return MODELS[ch] ?? null;
}

export function isBlockElementGlyph(ch: string): boolean {
  return blockElementModel(ch) !== null;
}

export function isBlockElementRun(text: string): boolean {
  const chars = [...text];
  return chars.length > 0 && chars.every(isBlockElementGlyph);
}
