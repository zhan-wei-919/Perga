// 设置解析与缩放夹取(settings.ts)。纯函数单测。

import { beforeEach, describe, expect, it } from "vitest";

import {
  BASE_FONT_SIZE,
  clampZoom,
  createSettings,
  parseSettings,
} from "../src/state/settings";

beforeEach(() => {
  localStorage.clear();
});

describe("clampZoom", () => {
  it("夹到 [50,200]", () => {
    expect(clampZoom(10)).toBe(50);
    expect(clampZoom(500)).toBe(200);
    expect(clampZoom(120)).toBe(120);
  });

  it("吸附到步进 10", () => {
    expect(clampZoom(123)).toBe(120);
    expect(clampZoom(127)).toBe(130);
  });

  it("非有限数 → 默认 100", () => {
    expect(clampZoom(NaN)).toBe(100);
    expect(clampZoom(Infinity)).toBe(100);
  });
});

describe("parseSettings", () => {
  it("合法 JSON round-trip", () => {
    const raw = JSON.stringify({
      zoomPercent: 150,
      themeId: "light",
      fontId: "compact",
    });
    expect(parseSettings(raw)).toEqual({
      zoomPercent: 150,
      themeId: "light",
      fontId: "compact",
    });
  });

  it("null → 全默认", () => {
    expect(parseSettings(null)).toEqual({
      zoomPercent: 100,
      themeId: "dark",
      fontId: "default",
    });
  });

  it("坏 JSON → 全默认", () => {
    expect(parseSettings("{not json")).toEqual({
      zoomPercent: 100,
      themeId: "dark",
      fontId: "default",
    });
  });

  it("非对象 JSON → 全默认", () => {
    expect(parseSettings("42")).toEqual({
      zoomPercent: 100,
      themeId: "dark",
      fontId: "default",
    });
  });

  it("逐字段独立兜底:越界 zoom / 未知 theme / 未知 font", () => {
    const raw = JSON.stringify({
      zoomPercent: 9999,
      themeId: "solarized",
      fontId: "nerd",
    });
    expect(parseSettings(raw)).toEqual({
      zoomPercent: 200,
      themeId: "dark",
      fontId: "default",
    });
  });

  it("缺字段 → 该字段回默认,其余保留", () => {
    expect(parseSettings(JSON.stringify({ themeId: "light" }))).toEqual({
      zoomPercent: 100,
      themeId: "light",
      fontId: "default",
    });
  });

  it("非整步 zoom 被吸附", () => {
    expect(parseSettings(JSON.stringify({ zoomPercent: 137 })).zoomPercent).toBe(
      140,
    );
  });
});

describe("createSettings", () => {
  it("默认有效字号使用基准字号", () => {
    const settings = createSettings();

    expect(settings.effectiveFontSize()).toBe(BASE_FONT_SIZE);
  });

  it("默认字体栈是可用的 CSS font-family", () => {
    const settings = createSettings();

    expect(settings.fontFamily()).toContain("monospace");
  });
});
