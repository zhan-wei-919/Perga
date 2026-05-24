// 主题 —— 终端 16 色调色板 + UI chrome 配色。
//
// 一个 `Theme` 同时驱动两处:
//   1. 终端调色板(`term`)—— DOM 终端文本的字符颜色。
//   2. UI chrome(`chrome`)—— tab 栏 / gutter / 命令块卡片 / 浮层等外壳颜色。
//
// `applyTheme` 把两者全写成 `:root` 的 CSS 自定义属性。chrome 与 DOM 终端
// 文本直接 `var(--…)` 消费 —— 切主题零重渲染。

import type { NamedColor } from "../state/protocol";

export type ThemeId =
  | "dark"
  | "light"
  | "rosepine"
  | "everforest"
  | "gruvbox"
  | "nord"
  | "dracula";

export const THEME_IDS: ThemeId[] = [
  "dark",
  "rosepine",
  "everforest",
  "gruvbox",
  "nord",
  "dracula",
  "light",
];

/// chrome CSS 变量名(不含 `--pg-` 前缀)。基础 bg/fg 直接复用
/// `--term-background` / `--term-foreground`,不在此重复定义。
export type ChromeVar =
  | "fg-dim"
  | "tabbar-bg"
  | "tabbar-border"
  | "tab-active-bg"
  | "tab-active-fg"
  | "tab-inactive-bg"
  | "tab-inactive-fg"
  | "gutter"
  | "accent"
  | "exit-fail"
  | "selection-bg"
  | "overlay-bg"
  | "overlay-border"
  | "overlay-hover"
  | "backdrop";

/// 一套主题:终端调色板 + chrome。`Record` 让 tsc 强制每个键齐全。
export type ThemeDef = {
  term: Record<NamedColor, string>;
  chrome: Record<ChromeVar, string>;
};

// 深色 —— Tokyo Night Moon 风格。
// 背景是冷蓝灰而非纯灰,前景柔白偏蓝,长时间盯屏不刺眼。
// ANSI 16 色都做了去饱和处理,避免「红配绿」的廉价感。
const DARK: ThemeDef = {
  term: {
    black: "#1b1d2b",
    red: "#ff757f",
    green: "#c3e88d",
    yellow: "#ffc777",
    blue: "#82aaff",
    magenta: "#c099ff",
    cyan: "#86e1fc",
    white: "#828bb8",
    bright_black: "#444a73",
    bright_red: "#ff8d94",
    bright_green: "#c7fb9c",
    bright_yellow: "#ffd29b",
    bright_blue: "#9fbdff",
    bright_magenta: "#caa9ff",
    bright_cyan: "#9ce5ff",
    bright_white: "#c8d3f5",
    foreground: "#c8d3f5",
    background: "#1e2030",
    cursor: "#c8d3f5",
    dim_black: "#15161e",
    dim_red: "#7d3a3e",
    dim_green: "#5f7146",
    dim_yellow: "#7d623a",
    dim_blue: "#3f547f",
    dim_magenta: "#5e4b7f",
    dim_cyan: "#436f7d",
    dim_white: "#535b80",
    bright_foreground: "#ffffff",
    dim_foreground: "#7a82a8",
  },
  chrome: {
    "fg-dim": "#7a82a8",
    "tabbar-bg": "#181a25",
    "tabbar-border": "#0f111a",
    "tab-active-bg": "#1e2030",
    "tab-active-fg": "#c8d3f5",
    "tab-inactive-bg": "#222436",
    "tab-inactive-fg": "#7a82a8",
    gutter: "#2f334d",
    accent: "#82aaff",
    "exit-fail": "#ff757f",
    "selection-bg": "rgba(130,170,255,0.32)",
    "overlay-bg": "#222436",
    "overlay-border": "#2f334d",
    "overlay-hover": "#2a2e44",
    backdrop: "rgba(15,17,26,0.55)",
  },
};

// 浅色 —— Catppuccin Latte 风格。
// 暖白底(#eff1f5)而非纯白,前景柔黑偏蓝紫,对比度足够但不刺眼;
// 16 色饱和度压低、保留色相辨识度,这是该配色在浅色终端里的主要卖点。
// `bright_white` 反向映到深色,这样 `\e[1;37m` 文本在浅底仍可见。
const LIGHT: ThemeDef = {
  term: {
    black: "#4c4f69",
    red: "#d20f39",
    green: "#40a02b",
    yellow: "#df8e1d",
    blue: "#1e66f5",
    magenta: "#ea76cb",
    cyan: "#179299",
    white: "#9ca0b0",
    bright_black: "#6c6f85",
    bright_red: "#e64553",
    bright_green: "#52aa3c",
    bright_yellow: "#ea9c2d",
    bright_blue: "#3577f7",
    bright_magenta: "#ee87d3",
    bright_cyan: "#1faaab",
    bright_white: "#4c4f69",
    foreground: "#4c4f69",
    background: "#eff1f5",
    cursor: "#4c4f69",
    dim_black: "#9ca0b0",
    dim_red: "#e88a99",
    dim_green: "#9ccc8d",
    dim_yellow: "#ebbe7f",
    dim_blue: "#8cb0f8",
    dim_magenta: "#f4bce0",
    dim_cyan: "#8acbcd",
    dim_white: "#ccd0da",
    bright_foreground: "#1e1e2e",
    dim_foreground: "#9ca0b0",
  },
  chrome: {
    "fg-dim": "#7c7f93",
    "tabbar-bg": "#e6e9ef",
    "tabbar-border": "#dce0e8",
    "tab-active-bg": "#eff1f5",
    "tab-active-fg": "#4c4f69",
    "tab-inactive-bg": "#dce0e8",
    "tab-inactive-fg": "#7c7f93",
    gutter: "#ccd0da",
    accent: "#1e66f5",
    "exit-fail": "#d20f39",
    "selection-bg": "rgba(30,102,245,0.22)",
    "overlay-bg": "#ffffff",
    "overlay-border": "#ccd0da",
    "overlay-hover": "#e6e9ef",
    backdrop: "rgba(76,79,105,0.25)",
  },
};

// 玫瑰松 —— Rosé Pine 风格。
// 暖紫深底(#191724),前景奶油紫(#e0def4);accent 用 iris 紫,标志色和
// 冷蓝系的 dark / 蓝紫系的 light 拉开距离。ANSI mapping 跟 Rosé Pine 官方
// 一致:cyan→rose、green→pine,色相整体偏暖,长时间盯屏舒服。
const ROSEPINE: ThemeDef = {
  term: {
    black: "#26233a",
    red: "#eb6f92",
    green: "#31748f",
    yellow: "#f6c177",
    blue: "#9ccfd8",
    magenta: "#c4a7e7",
    cyan: "#ebbcba",
    white: "#e0def4",
    bright_black: "#6e6a86",
    bright_red: "#f08aa8",
    bright_green: "#3e8fb0",
    bright_yellow: "#f9d49b",
    bright_blue: "#b3ddea",
    bright_magenta: "#d3bcef",
    bright_cyan: "#f0d0cf",
    bright_white: "#f4f1ff",
    foreground: "#e0def4",
    background: "#191724",
    cursor: "#e0def4",
    dim_black: "#15131e",
    dim_red: "#7a3a4c",
    dim_green: "#1d3d4a",
    dim_yellow: "#7b613b",
    dim_blue: "#516a70",
    dim_magenta: "#665578",
    dim_cyan: "#79615f",
    dim_white: "#76728e",
    bright_foreground: "#ffffff",
    dim_foreground: "#6e6a86",
  },
  chrome: {
    "fg-dim": "#908caa",
    "tabbar-bg": "#13111c",
    "tabbar-border": "#0e0c16",
    "tab-active-bg": "#191724",
    "tab-active-fg": "#e0def4",
    "tab-inactive-bg": "#1f1d2e",
    "tab-inactive-fg": "#908caa",
    gutter: "#26233a",
    accent: "#c4a7e7",
    "exit-fail": "#eb6f92",
    "selection-bg": "rgba(196,167,231,0.28)",
    "overlay-bg": "#1f1d2e",
    "overlay-border": "#2a2840",
    "overlay-hover": "#26233a",
    backdrop: "rgba(15,12,24,0.55)",
  },
};

// 林海 —— Everforest 风格(Dark Medium)。
// 深绿灰底(#2d353b)+ 米白前景(#d3c6aa),整体走暖色低饱和路线,色相由
// sage 绿 / 暖红 / 蜂蜜黄主导。accent 用标志性的 sage 绿 #a7c080,跟 Tokyo
// Night 的蓝、Rosé Pine 的紫拉开色系。终端老用户对这套很熟,长时间盯屏舒服。
const EVERFOREST: ThemeDef = {
  term: {
    black: "#343f44",
    red: "#e67e80",
    green: "#a7c080",
    yellow: "#dbbc7f",
    blue: "#7fbbb3",
    magenta: "#d699b6",
    cyan: "#83c092",
    white: "#d3c6aa",
    bright_black: "#7a8478",
    bright_red: "#ec9a9c",
    bright_green: "#b8d196",
    bright_yellow: "#e7cd9a",
    bright_blue: "#95c9c3",
    bright_magenta: "#e0adc3",
    bright_cyan: "#9ad0a3",
    bright_white: "#e2d6bd",
    foreground: "#d3c6aa",
    background: "#2d353b",
    cursor: "#d3c6aa",
    dim_black: "#232a2e",
    dim_red: "#754748",
    dim_green: "#5b6c4a",
    dim_yellow: "#7a684a",
    dim_blue: "#4a6c69",
    dim_magenta: "#71566b",
    dim_cyan: "#4d6f57",
    dim_white: "#6f6a59",
    bright_foreground: "#f0e6c8",
    dim_foreground: "#859289",
  },
  chrome: {
    "fg-dim": "#859289",
    "tabbar-bg": "#232a2e",
    "tabbar-border": "#1b2125",
    "tab-active-bg": "#2d353b",
    "tab-active-fg": "#d3c6aa",
    "tab-inactive-bg": "#343f44",
    "tab-inactive-fg": "#859289",
    gutter: "#3d484d",
    accent: "#a7c080",
    "exit-fail": "#e67e80",
    "selection-bg": "rgba(167,192,128,0.26)",
    "overlay-bg": "#343f44",
    "overlay-border": "#475258",
    "overlay-hover": "#3d484d",
    backdrop: "rgba(20,25,28,0.55)",
  },
};

// 山隘 —— Gruvbox Dark Medium 风格。
// 暖深褐底(#282828)+ 米黄前景(#ebdbb2),色相整体偏暖低饱和。accent 用
// 招牌暖黄 #fabd2f ── 比 dark 的冷蓝、everforest 的 sage 绿对比更强,适合
// 喜欢「复古终端味儿」的用户。ANSI 沿 Gruvbox 官方 medium contrast 配色。
const GRUVBOX: ThemeDef = {
  term: {
    black: "#282828",
    red: "#cc241d",
    green: "#98971a",
    yellow: "#d79921",
    blue: "#458588",
    magenta: "#b16286",
    cyan: "#689d6a",
    white: "#a89984",
    bright_black: "#928374",
    bright_red: "#fb4934",
    bright_green: "#b8bb26",
    bright_yellow: "#fabd2f",
    bright_blue: "#83a598",
    bright_magenta: "#d3869b",
    bright_cyan: "#8ec07c",
    bright_white: "#ebdbb2",
    foreground: "#ebdbb2",
    background: "#282828",
    cursor: "#ebdbb2",
    dim_black: "#1d2021",
    dim_red: "#722e2c",
    dim_green: "#5b5a1f",
    dim_yellow: "#7d5a25",
    dim_blue: "#34555a",
    dim_magenta: "#6b3f54",
    dim_cyan: "#3f5e44",
    dim_white: "#7c6f64",
    bright_foreground: "#fbf1c7",
    dim_foreground: "#928374",
  },
  chrome: {
    "fg-dim": "#928374",
    "tabbar-bg": "#1d2021",
    "tabbar-border": "#16181a",
    "tab-active-bg": "#282828",
    "tab-active-fg": "#ebdbb2",
    "tab-inactive-bg": "#32302f",
    "tab-inactive-fg": "#928374",
    gutter: "#3c3836",
    accent: "#fabd2f",
    "exit-fail": "#fb4934",
    "selection-bg": "rgba(250,189,47,0.26)",
    "overlay-bg": "#32302f",
    "overlay-border": "#504945",
    "overlay-hover": "#3c3836",
    backdrop: "rgba(20,20,20,0.55)",
  },
};

// 北境 —— Nord 风格。
// 冷蓝灰底(#2e3440 Polar Night 0)+ 雪白前景(#d8dee9 Snow Storm 1),色相
// 整体往蓝冷漂。accent 用 Frost 2 的冰青 #88c0d0,比 dark 的 Tokyo Night 蓝
// 更柔、更冷。Aurora 系列做 ANSI 强调色,饱和度比较低,长时间盯屏舒服。
const NORD: ThemeDef = {
  term: {
    black: "#3b4252",
    red: "#bf616a",
    green: "#a3be8c",
    yellow: "#ebcb8b",
    blue: "#81a1c1",
    magenta: "#b48ead",
    cyan: "#88c0d0",
    white: "#e5e9f0",
    bright_black: "#4c566a",
    bright_red: "#d08770",
    bright_green: "#a3be8c",
    bright_yellow: "#ebcb8b",
    bright_blue: "#81a1c1",
    bright_magenta: "#b48ead",
    bright_cyan: "#8fbcbb",
    bright_white: "#eceff4",
    foreground: "#d8dee9",
    background: "#2e3440",
    cursor: "#d8dee9",
    dim_black: "#272b35",
    dim_red: "#6c393e",
    dim_green: "#5d6c50",
    dim_yellow: "#84724f",
    dim_blue: "#4a5b6e",
    dim_magenta: "#665064",
    dim_cyan: "#4d6e76",
    dim_white: "#7c8593",
    bright_foreground: "#eceff4",
    dim_foreground: "#7b8394",
  },
  chrome: {
    "fg-dim": "#7b8394",
    "tabbar-bg": "#272b35",
    "tabbar-border": "#1d2028",
    "tab-active-bg": "#2e3440",
    "tab-active-fg": "#d8dee9",
    "tab-inactive-bg": "#353b48",
    "tab-inactive-fg": "#7b8394",
    gutter: "#3b4252",
    accent: "#88c0d0",
    "exit-fail": "#bf616a",
    "selection-bg": "rgba(136,192,208,0.28)",
    "overlay-bg": "#353b48",
    "overlay-border": "#434c5e",
    "overlay-hover": "#3b4252",
    backdrop: "rgba(20,24,32,0.55)",
  },
};

// 德古拉 —— Dracula 官方风格。
// 深紫黑底(#282a36)+ 雪白前景(#f8f8f2)。色相很饱和但 dark0 压住对比;
// accent 用招牌紫 #bd93f9,与 cyan(青)、pink(粉)、green(荧光绿)
// 一起组成 Dracula 标志的「霓虹紫粉绿」配色。适合喜欢高对比鲜艳色的用户。
const DRACULA: ThemeDef = {
  term: {
    black: "#21222c",
    red: "#ff5555",
    green: "#50fa7b",
    yellow: "#f1fa8c",
    blue: "#bd93f9",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    white: "#f8f8f2",
    bright_black: "#6272a4",
    bright_red: "#ff6e6e",
    bright_green: "#69ff94",
    bright_yellow: "#ffffa5",
    bright_blue: "#d6acff",
    bright_magenta: "#ff92df",
    bright_cyan: "#a4ffff",
    bright_white: "#ffffff",
    foreground: "#f8f8f2",
    background: "#282a36",
    cursor: "#f8f8f2",
    dim_black: "#15161d",
    dim_red: "#7d2e2e",
    dim_green: "#2b7d3f",
    dim_yellow: "#777d46",
    dim_blue: "#5d487a",
    dim_magenta: "#7d3e63",
    dim_cyan: "#447580",
    dim_white: "#7c7c77",
    bright_foreground: "#ffffff",
    dim_foreground: "#6272a4",
  },
  chrome: {
    "fg-dim": "#6272a4",
    "tabbar-bg": "#1e1f29",
    "tabbar-border": "#15161d",
    "tab-active-bg": "#282a36",
    "tab-active-fg": "#f8f8f2",
    "tab-inactive-bg": "#2f3142",
    "tab-inactive-fg": "#6272a4",
    gutter: "#44475a",
    accent: "#bd93f9",
    "exit-fail": "#ff5555",
    "selection-bg": "rgba(189,147,249,0.30)",
    "overlay-bg": "#2f3142",
    "overlay-border": "#44475a",
    "overlay-hover": "#363849",
    backdrop: "rgba(15,15,22,0.55)",
  },
};

export const THEMES: Record<ThemeId, ThemeDef> = {
  dark: DARK,
  rosepine: ROSEPINE,
  everforest: EVERFOREST,
  gruvbox: GRUVBOX,
  nord: NORD,
  dracula: DRACULA,
  light: LIGHT,
};

/// 终端调色板:`NamedColor` → 具体颜色串。
export type TermPalette = Record<NamedColor, string>;

/// 取某主题的终端调色板(具体色,不含 `var()`)。
export function paletteForTheme(id: ThemeId): TermPalette {
  return THEMES[id].term;
}

/// 把主题写进 `:root` 的 CSS 自定义属性。纯 DOM 副作用,不涉及 Solid。
///
/// term 写成 `--term-<NamedColor>`,chrome 写成 `--pg-<ChromeVar>`。chrome 与
/// DOM 终端文本 `var()` 消费这些值 —— 调用本函数即完成换肤,无需重渲染。
export function applyTheme(id: ThemeId): void {
  const def = THEMES[id];
  const style = document.documentElement.style;
  for (const [key, value] of Object.entries(def.term)) {
    style.setProperty(`--term-${key}`, value);
  }
  for (const [key, value] of Object.entries(def.chrome)) {
    style.setProperty(`--pg-${key}`, value);
  }
}
