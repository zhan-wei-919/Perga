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
  | "classic"
  | "solarizedDark"
  | "gruvboxDark"
  | "highContrast";

export const THEME_IDS: ThemeId[] = [
  "dark",
  "light",
  "classic",
  "solarizedDark",
  "gruvboxDark",
  "highContrast",
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

// 深色 —— VS Code Dark+ 风格,沿用 Phase 1 的 16 色基本盘。
const DARK: ThemeDef = {
  term: {
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
    foreground: "#d4d4d4",
    background: "#1e1e1e",
    cursor: "#ffffff",
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
  },
  chrome: {
    "fg-dim": "#888888",
    "tabbar-bg": "#252526",
    "tabbar-border": "#1a1a1a",
    "tab-active-bg": "#1e1e1e",
    "tab-active-fg": "#ffffff",
    "tab-inactive-bg": "#2d2d2d",
    "tab-inactive-fg": "#969696",
    gutter: "#333333",
    accent: "#3b8eea",
    "exit-fail": "#f14c4c",
    "selection-bg": "rgba(59,142,234,0.42)",
    "overlay-bg": "#2a2a2c",
    "overlay-border": "#3a3a3a",
    "overlay-hover": "#37373a",
    backdrop: "rgba(0,0,0,0.5)",
  },
};

// 浅色 —— 浅底,16 色为在白底上可读而整体加深;`bright_white` 反向映到
// 近黑,这样 `\e[1;37m` 文本在浅色终端仍可见(浅色终端的通行约定)。
const LIGHT: ThemeDef = {
  term: {
    black: "#2e2e2e",
    red: "#c5221f",
    green: "#1a7f37",
    yellow: "#9a6700",
    blue: "#0a5fc4",
    magenta: "#a32aa3",
    cyan: "#118693",
    white: "#9b9b9b",
    bright_black: "#6b6b6b",
    bright_red: "#e0382f",
    bright_green: "#2ea043",
    bright_yellow: "#b78400",
    bright_blue: "#2b7ec8",
    bright_magenta: "#c44ac4",
    bright_cyan: "#1aa1b0",
    bright_white: "#2e2e2e",
    foreground: "#2e2e2e",
    background: "#fbfbfb",
    cursor: "#2e2e2e",
    dim_black: "#7d7d7d",
    dim_red: "#d98f8d",
    dim_green: "#8fc09b",
    dim_yellow: "#c4ab73",
    dim_blue: "#86acd8",
    dim_magenta: "#cf95cf",
    dim_cyan: "#8fbfc6",
    dim_white: "#c2c2c2",
    bright_foreground: "#000000",
    dim_foreground: "#9a9a9a",
  },
  chrome: {
    "fg-dim": "#8a8a8a",
    "tabbar-bg": "#ececec",
    "tabbar-border": "#d0d0d0",
    "tab-active-bg": "#fbfbfb",
    "tab-active-fg": "#1a1a1a",
    "tab-inactive-bg": "#dcdcdc",
    "tab-inactive-fg": "#6a6a6a",
    gutter: "#c4c4c4",
    accent: "#0a5fc4",
    "exit-fail": "#d11a1a",
    "selection-bg": "rgba(10,95,196,0.28)",
    "overlay-bg": "#ffffff",
    "overlay-border": "#d0d0d0",
    "overlay-hover": "#e8e8e8",
    backdrop: "rgba(0,0,0,0.3)",
  },
};

const CLASSIC: ThemeDef = {
  term: {
    black: "#000000",
    red: "#cc0000",
    green: "#4e9a06",
    yellow: "#c4a000",
    blue: "#3465a4",
    magenta: "#75507b",
    cyan: "#06989a",
    white: "#d3d7cf",
    bright_black: "#555753",
    bright_red: "#ef2929",
    bright_green: "#8ae234",
    bright_yellow: "#fce94f",
    bright_blue: "#729fcf",
    bright_magenta: "#ad7fa8",
    bright_cyan: "#34e2e2",
    bright_white: "#eeeeec",
    foreground: "#f2f2f2",
    background: "#000000",
    cursor: "#f2f2f2",
    dim_black: "#000000",
    dim_red: "#7a0000",
    dim_green: "#2f5c04",
    dim_yellow: "#766000",
    dim_blue: "#1f3d63",
    dim_magenta: "#46304a",
    dim_cyan: "#045b5c",
    dim_white: "#7e817c",
    bright_foreground: "#ffffff",
    dim_foreground: "#8a8a8a",
  },
  chrome: {
    "fg-dim": "#8a8a8a",
    "tabbar-bg": "#111111",
    "tabbar-border": "#000000",
    "tab-active-bg": "#000000",
    "tab-active-fg": "#ffffff",
    "tab-inactive-bg": "#191919",
    "tab-inactive-fg": "#a0a0a0",
    gutter: "#202020",
    accent: "#729fcf",
    "exit-fail": "#ef2929",
    "selection-bg": "rgba(114,159,207,0.42)",
    "overlay-bg": "#111111",
    "overlay-border": "#343434",
    "overlay-hover": "#1f1f1f",
    backdrop: "rgba(0,0,0,0.62)",
  },
};

const SOLARIZED_DARK: ThemeDef = {
  term: {
    black: "#073642",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    white: "#eee8d5",
    bright_black: "#586e75",
    bright_red: "#cb4b16",
    bright_green: "#586e75",
    bright_yellow: "#657b83",
    bright_blue: "#839496",
    bright_magenta: "#6c71c4",
    bright_cyan: "#93a1a1",
    bright_white: "#fdf6e3",
    foreground: "#839496",
    background: "#002b36",
    cursor: "#93a1a1",
    dim_black: "#04262e",
    dim_red: "#84201d",
    dim_green: "#505c00",
    dim_yellow: "#6d5200",
    dim_blue: "#17537e",
    dim_magenta: "#7e204e",
    dim_cyan: "#19615b",
    dim_white: "#8f8b80",
    bright_foreground: "#fdf6e3",
    dim_foreground: "#586e75",
  },
  chrome: {
    "fg-dim": "#586e75",
    "tabbar-bg": "#073642",
    "tabbar-border": "#00212a",
    "tab-active-bg": "#002b36",
    "tab-active-fg": "#eee8d5",
    "tab-inactive-bg": "#0d3f4c",
    "tab-inactive-fg": "#839496",
    gutter: "#073642",
    accent: "#268bd2",
    "exit-fail": "#dc322f",
    "selection-bg": "rgba(38,139,210,0.38)",
    "overlay-bg": "#073642",
    "overlay-border": "#164b59",
    "overlay-hover": "#0d3f4c",
    backdrop: "rgba(0,20,26,0.62)",
  },
};

const GRUVBOX_DARK: ThemeDef = {
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
    dim_black: "#181818",
    dim_red: "#7a1611",
    dim_green: "#5b5a10",
    dim_yellow: "#815c14",
    dim_blue: "#294f52",
    dim_magenta: "#6a3b50",
    dim_cyan: "#3e5e40",
    dim_white: "#655c4f",
    bright_foreground: "#fbf1c7",
    dim_foreground: "#928374",
  },
  chrome: {
    "fg-dim": "#928374",
    "tabbar-bg": "#1d2021",
    "tabbar-border": "#141617",
    "tab-active-bg": "#282828",
    "tab-active-fg": "#fbf1c7",
    "tab-inactive-bg": "#32302f",
    "tab-inactive-fg": "#a89984",
    gutter: "#3c3836",
    accent: "#83a598",
    "exit-fail": "#fb4934",
    "selection-bg": "rgba(131,165,152,0.36)",
    "overlay-bg": "#32302f",
    "overlay-border": "#504945",
    "overlay-hover": "#3c3836",
    backdrop: "rgba(20,18,16,0.58)",
  },
};

const HIGH_CONTRAST: ThemeDef = {
  term: {
    black: "#000000",
    red: "#ff5f5f",
    green: "#00ff87",
    yellow: "#ffff5f",
    blue: "#5fafff",
    magenta: "#ff87ff",
    cyan: "#00ffff",
    white: "#e6e6e6",
    bright_black: "#808080",
    bright_red: "#ff8787",
    bright_green: "#5fffaf",
    bright_yellow: "#ffff87",
    bright_blue: "#87c8ff",
    bright_magenta: "#ffafff",
    bright_cyan: "#5fffff",
    bright_white: "#ffffff",
    foreground: "#ffffff",
    background: "#000000",
    cursor: "#ffffff",
    dim_black: "#000000",
    dim_red: "#993939",
    dim_green: "#009951",
    dim_yellow: "#999939",
    dim_blue: "#396999",
    dim_magenta: "#995199",
    dim_cyan: "#009999",
    dim_white: "#8a8a8a",
    bright_foreground: "#ffffff",
    dim_foreground: "#b0b0b0",
  },
  chrome: {
    "fg-dim": "#c0c0c0",
    "tabbar-bg": "#000000",
    "tabbar-border": "#ffffff",
    "tab-active-bg": "#111111",
    "tab-active-fg": "#ffffff",
    "tab-inactive-bg": "#000000",
    "tab-inactive-fg": "#d0d0d0",
    gutter: "#ffffff",
    accent: "#00ffff",
    "exit-fail": "#ff5f5f",
    "selection-bg": "rgba(0,255,255,0.45)",
    "overlay-bg": "#000000",
    "overlay-border": "#ffffff",
    "overlay-hover": "#222222",
    backdrop: "rgba(0,0,0,0.72)",
  },
};

export const THEMES: Record<ThemeId, ThemeDef> = {
  dark: DARK,
  light: LIGHT,
  classic: CLASSIC,
  solarizedDark: SOLARIZED_DARK,
  gruvboxDark: GRUVBOX_DARK,
  highContrast: HIGH_CONTRAST,
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
