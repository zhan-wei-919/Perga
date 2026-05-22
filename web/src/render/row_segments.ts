// 一行 cell → 渲染段:把同 style 的连续 cell 合并成段。DOM 历史行据此渲染。
//
// 从原命令块渲染层(block_one.tsx)救出的纯函数 —— 普通滚动终端的 DOM 历史
// 行复用同一套逻辑。不依赖 Solid。

import type { Cell, CellAttr, Color } from "../state/protocol";
import { colorToDomCss } from "./palette";

/// 一行里同 style 的连续 cell 合并成的一段。
export type RowSegment = {
  text: string;
  fg: Color;
  bg: Color;
  attrs: CellAttr[];
};

function isDefaultFg(c: Color): boolean {
  return "named" in c && c.named === "foreground";
}

function isDefaultBg(c: Color): boolean {
  return "named" in c && c.named === "background";
}

function isDefaultBlank(c: Cell): boolean {
  return (
    c.ch === " " &&
    c.combining.length === 0 &&
    c.width === "single" &&
    c.attrs.length === 0 &&
    isDefaultFg(c.fg) &&
    isDefaultBg(c.bg)
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

/// 把一行 cell 合并成 segment。先裁掉行尾的默认空白(复制时不带尾随空格),
/// 再按相同 style 合并。宽字符占位格丢弃 —— 主字符在 monospace 下自占两列。
export function segmentsForRow(cells: Cell[]): RowSegment[] {
  let end = cells.length;
  while (end > 0 && isDefaultBlank(cells[end - 1])) end--;

  const out: RowSegment[] = [];
  let cur: RowSegment | undefined;
  for (let i = 0; i < end; i++) {
    const cell = cells[i];
    if (cell.width === "wide_spacer") continue;
    const glyph =
      cell.combining.length > 0 ? cell.ch + cell.combining.join("") : cell.ch;
    if (
      cur &&
      sameColor(cur.fg, cell.fg) &&
      sameColor(cur.bg, cell.bg) &&
      sameAttrs(cur.attrs, cell.attrs)
    ) {
      cur.text += glyph;
    } else {
      cur = { text: glyph, fg: cell.fg, bg: cell.bg, attrs: cell.attrs };
      out.push(cur);
    }
  }
  return out;
}

/// segment → 内联 CSS。默认背景不落 `background`,让容器底色透出来。
/// named / indexed-0..15 走 `var(--term-…)`,切主题靠 CSS 变量、零重渲染。
export function segmentStyle(seg: RowSegment): Record<string, string> {
  const reverse = seg.attrs.includes("reverse");
  const fg = reverse ? seg.bg : seg.fg;
  const bg = reverse ? seg.fg : seg.bg;
  const style: Record<string, string> = { color: colorToDomCss(fg, "fg") };
  if (!isDefaultBg(bg)) style.background = colorToDomCss(bg, "bg");
  if (seg.attrs.includes("bold")) style["font-weight"] = "bold";
  if (seg.attrs.includes("italic")) style["font-style"] = "italic";
  const deco: string[] = [];
  if (seg.attrs.includes("underline")) deco.push("underline");
  if (seg.attrs.includes("strikethrough")) deco.push("line-through");
  if (deco.length > 0) style["text-decoration"] = deco.join(" ");
  if (seg.attrs.includes("hidden")) style.visibility = "hidden";
  return style;
}
