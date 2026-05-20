// 终端颜色 → CSS 颜色字符串。
//
// 后端不做 palette 映射(它只会发 NamedColor / Indexed / Rgb),前端按主题
// 决定怎么落地。这里写死一个深色 VS Code 风格 16 色 + 标准 xterm 256 色 cube,
// Phase 4 抛光阶段再做用户可定制主题。

import type { Color, NamedColor } from "../state/protocol";

const FG_DEFAULT = "#d4d4d4";
const BG_DEFAULT = "#1e1e1e";

// 16 色基本盘。bright_* 是高亮版本,dim_* 是低饱和版本。
// 选色参考 VS Code Dark+ 主题,与 index.html 的 body 默认配色衔接。
const NAMED: Record<NamedColor, string> = {
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  bright_black: "#666666",
  bright_red: "#f14c4c",
  bright_green: "#23d18b",
  bright_yellow: "#f5f543",
  bright_blue: "#3b8eea",
  bright_magenta: "#d670d6",
  bright_cyan: "#29b8db",
  bright_white: "#ffffff",
  foreground: FG_DEFAULT,
  background: BG_DEFAULT,
  cursor: "#ffffff",
  // Dim:简单缩 60% 亮度,Phase 1 不细调。
  dim_black: "#000000",
  dim_red: "#7a1d1d",
  dim_green: "#087148",
  dim_yellow: "#8b8b09",
  dim_blue: "#164578",
  dim_magenta: "#702670",
  dim_cyan: "#0a6678",
  dim_white: "#898989",
  bright_foreground: "#ffffff",
  dim_foreground: "#888888",
};

/// xterm 256 色 indexed palette。0..15 是 NAMED 16 色,16..231 是 6×6×6 cube,
/// 232..255 是 24 阶灰度。
export function colorToCss(c: Color, kind: "fg" | "bg"): string {
  if ("named" in c) {
    return NAMED[c.named];
  }
  if ("rgb" in c) {
    return `rgb(${c.rgb.r},${c.rgb.g},${c.rgb.b})`;
  }
  return indexedColor(c.indexed, kind);
}

function indexedColor(idx: number, kind: "fg" | "bg"): string {
  if (idx >= 0 && idx < 16) {
    // 0..7 对应 black..white,8..15 对应 bright_black..bright_white。
    const names: NamedColor[] = [
      "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
      "bright_black", "bright_red", "bright_green", "bright_yellow",
      "bright_blue", "bright_magenta", "bright_cyan", "bright_white",
    ];
    return NAMED[names[idx]];
  }
  if (idx >= 16 && idx < 232) {
    const i = idx - 16;
    const r = Math.floor(i / 36);
    const g = Math.floor((i % 36) / 6);
    const b = i % 6;
    const v = (n: number): number => (n === 0 ? 0 : 55 + n * 40);
    return `rgb(${v(r)},${v(g)},${v(b)})`;
  }
  if (idx >= 232 && idx <= 255) {
    const v = 8 + (idx - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  // 越界:把责任丢回 caller 类型上 ── server 端 u8,理论上不可能。
  return kind === "fg" ? FG_DEFAULT : BG_DEFAULT;
}
