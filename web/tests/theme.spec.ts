// 主题表完整性 + 颜色解析(theme.ts / palette.ts)。
// 沿项目惯例:测纯函数,不挂载组件。applyTheme 写 documentElement,jsdom 支持。

import { describe, expect, it } from "vitest";

import { colorToDomCss } from "../src/render/palette";
import {
  THEME_IDS,
  THEMES,
  applyTheme,
  paletteForTheme,
} from "../src/render/theme";
import type { NamedColor } from "../src/state/protocol";

// 与 protocol.ts 的 NamedColor 联合一一对应 —— 漏一个,下面的断言会抓到。
const NAMED_COLORS: NamedColor[] = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "bright_black", "bright_red", "bright_green", "bright_yellow",
  "bright_blue", "bright_magenta", "bright_cyan", "bright_white",
  "foreground", "background", "cursor",
  "dim_black", "dim_red", "dim_green", "dim_yellow", "dim_blue",
  "dim_magenta", "dim_cyan", "dim_white",
  "bright_foreground", "dim_foreground",
];

describe("THEMES", () => {
  it("每个主题的 term 都齐了全部 NamedColor 且非空", () => {
    for (const id of THEME_IDS) {
      for (const name of NAMED_COLORS) {
        const v = THEMES[id].term[name];
        expect(v, `${id}.term.${name}`).toBeTruthy();
      }
    }
  });

  it("每个主题的 chrome 值都非空", () => {
    for (const id of THEME_IDS) {
      for (const v of Object.values(THEMES[id].chrome)) {
        expect(v).toBeTruthy();
      }
    }
  });

  it("paletteForTheme 返回具体色,不含 var()", () => {
    for (const id of THEME_IDS) {
      for (const v of Object.values(paletteForTheme(id))) {
        expect(v).not.toContain("var(");
      }
    }
  });

  it("深浅两套是不同的配色", () => {
    expect(THEMES.dark.term.background).not.toBe(THEMES.light.term.background);
  });
});

describe("applyTheme", () => {
  it("把 term / chrome 写进 :root 的 CSS 变量", () => {
    applyTheme("dark");
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--term-red")).toBe(THEMES.dark.term.red);
    expect(root.style.getPropertyValue("--pg-tabbar-bg")).toBe(
      THEMES.dark.chrome["tabbar-bg"],
    );
  });

  it("切主题会覆盖旧值", () => {
    applyTheme("dark");
    applyTheme("light");
    expect(document.documentElement.style.getPropertyValue("--term-background")).toBe(
      THEMES.light.term.background,
    );
  });
});

describe("colorToDomCss", () => {
  it("named / indexed-0..15 走 var(--term-…)", () => {
    expect(colorToDomCss({ named: "red" }, "fg")).toBe("var(--term-red)");
    expect(colorToDomCss({ indexed: 5 }, "fg")).toBe("var(--term-magenta)");
    expect(colorToDomCss({ indexed: 9 }, "fg")).toBe("var(--term-bright_red)");
  });

  it("rgb / indexed-16..255 返回具体色", () => {
    expect(colorToDomCss({ rgb: { r: 10, g: 20, b: 30 } }, "fg")).toBe(
      "rgb(10,20,30)",
    );
    expect(colorToDomCss({ indexed: 16 }, "fg")).toMatch(/^rgb\(/);
    expect(colorToDomCss({ indexed: 240 }, "fg")).toMatch(/^rgb\(/);
  });

  it("越界 indexed 兜底到默认前 / 背景", () => {
    expect(colorToDomCss({ indexed: 999 }, "fg")).toBe("var(--term-foreground)");
    expect(colorToDomCss({ indexed: -1 }, "bg")).toBe("var(--term-background)");
  });
});
