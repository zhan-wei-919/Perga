// 主题 —— 终端 16 色调色板 + UI chrome 配色,深 / 浅各一套。
//
// 一个 `Theme` 同时驱动两处:
//   1. 终端调色板(`term`)—— DOM 终端文本的字符颜色。
//   2. UI chrome(`chrome`)—— tab 栏 / gutter / 命令块卡片 / 浮层等外壳颜色。
//
// `applyTheme` 把两者全写成 `:root` 的 CSS 自定义属性。chrome 与 DOM 终端
// 文本直接 `var(--…)` 消费 —— 切主题零重渲染。

import type { NamedColor } from "../state/protocol";

export type ThemeId = "dark" | "light";

export const THEME_IDS: ThemeId[] = ["dark", "light"];

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
    "overlay-bg": "#ffffff",
    "overlay-border": "#d0d0d0",
    "overlay-hover": "#e8e8e8",
    backdrop: "rgba(0,0,0,0.3)",
  },
};

export const THEMES: Record<ThemeId, ThemeDef> = { dark: DARK, light: LIGHT };

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
