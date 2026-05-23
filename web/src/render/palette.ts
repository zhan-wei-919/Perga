// 终端颜色 → CSS 颜色字符串。
//
// 后端只发 NamedColor / Indexed / Rgb,前端按主题落地。
//
// DOM 路径里 named / indexed-0..15 返回 `var(--term-…)`,切主题靠 CSS 变量
// 更新、零重渲染。256 色 cube(16..231)与灰度阶梯(232..255)与主题无关,
// 返回具体 rgb。
//
import type { Color, NamedColor } from "../state/protocol";

// indexed 0..15 → NamedColor:0..7 = black..white,8..15 = bright_*。
const INDEX16: NamedColor[] = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "bright_black", "bright_red", "bright_green", "bright_yellow",
  "bright_blue", "bright_magenta", "bright_cyan", "bright_white",
];

/// named / indexed-0..15 走 `var(--term-…)`,rgb / indexed-16..255 与主题
/// 无关、返回具体色。
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
