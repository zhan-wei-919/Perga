// 终端颜色 → CSS 颜色字符串。
//
// 后端只发 NamedColor / Indexed / Rgb,前端按主题落地。颜色解析分两条路:
//
//   - `colorToDomCss` —— DOM 命令块用。named / indexed-0..15 返回
//     `var(--term-…)`,切主题靠 CSS 变量更新、零重渲染。
//   - `colorToCanvasCss` —— Canvas 用。`ctx.fillStyle` **不接受 `var()`**
//     (会被解析成透明黑),所以全程返回具体颜色串,从当前主题的 `TermPalette`
//     查表。调用方每帧解析一次主题调色板后传入。
//
// 256 色 cube(16..231)与灰度阶梯(232..255)与主题无关,两条路共用。

import type { Color, NamedColor } from "../state/protocol";
import type { TermPalette } from "./theme";

// indexed 0..15 → NamedColor:0..7 = black..white,8..15 = bright_*。
const INDEX16: NamedColor[] = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "bright_black", "bright_red", "bright_green", "bright_yellow",
  "bright_blue", "bright_magenta", "bright_cyan", "bright_white",
];

/// Canvas 路径:始终具体色。`term` 是当前主题调色板,调用方每帧解析一次传入。
export function colorToCanvasCss(
  c: Color,
  kind: "fg" | "bg",
  term: TermPalette,
): string {
  if ("named" in c) return term[c.named];
  if ("rgb" in c) return rgbCss(c.rgb);
  if (c.indexed >= 0 && c.indexed < 16) return term[INDEX16[c.indexed]];
  if (c.indexed >= 16 && c.indexed <= 255) return cubeOrGray(c.indexed);
  // 越界:server 端是 u8,理论不可能 —— 兜底到默认前 / 背景色。
  return term[kind === "fg" ? "foreground" : "background"];
}

/// DOM 路径:named / indexed-0..15 走 `var(--term-…)`,rgb / indexed-16..255
/// 与主题无关、返回具体色。
export function colorToDomCss(c: Color, kind: "fg" | "bg"): string {
  if ("named" in c) return termVar(c.named);
  if ("rgb" in c) return rgbCss(c.rgb);
  if (c.indexed >= 0 && c.indexed < 16) return termVar(INDEX16[c.indexed]);
  if (c.indexed >= 16 && c.indexed <= 255) return cubeOrGray(c.indexed);
  return termVar(kind === "fg" ? "foreground" : "background");
}

function termVar(name: NamedColor): string {
  return `var(--term-${name})`;
}

function rgbCss(rgb: { r: number; g: number; b: number }): string {
  return `rgb(${rgb.r},${rgb.g},${rgb.b})`;
}

/// xterm 256 色:cube(16..231)= 6×6×6,灰度(232..255)= 24 阶。
function cubeOrGray(idx: number): string {
  if (idx < 232) {
    const i = idx - 16;
    const r = Math.floor(i / 36);
    const g = Math.floor((i % 36) / 6);
    const b = i % 6;
    const v = (n: number): number => (n === 0 ? 0 : 55 + n * 40);
    return `rgb(${v(r)},${v(g)},${v(b)})`;
  }
  const v = 8 + (idx - 232) * 10;
  return `rgb(${v},${v},${v})`;
}
