// 设置解析与缩放夹取(settings.ts)。纯函数单测。

import { describe, expect, it } from "vitest";

import { clampZoom, parseSettings } from "../src/state/settings";

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
    const raw = JSON.stringify({ zoomPercent: 150, themeId: "light" });
    expect(parseSettings(raw)).toEqual({ zoomPercent: 150, themeId: "light" });
  });

  it("null → 全默认", () => {
    expect(parseSettings(null)).toEqual({ zoomPercent: 100, themeId: "dark" });
  });

  it("坏 JSON → 全默认", () => {
    expect(parseSettings("{not json")).toEqual({
      zoomPercent: 100,
      themeId: "dark",
    });
  });

  it("非对象 JSON → 全默认", () => {
    expect(parseSettings("42")).toEqual({ zoomPercent: 100, themeId: "dark" });
  });

  it("逐字段独立兜底:越界 zoom / 未知 theme", () => {
    const raw = JSON.stringify({ zoomPercent: 9999, themeId: "solarized" });
    expect(parseSettings(raw)).toEqual({ zoomPercent: 200, themeId: "dark" });
  });

  it("缺字段 → 该字段回默认,其余保留", () => {
    expect(parseSettings(JSON.stringify({ themeId: "light" }))).toEqual({
      zoomPercent: 100,
      themeId: "light",
    });
  });

  it("非整步 zoom 被吸附", () => {
    expect(parseSettings(JSON.stringify({ zoomPercent: 137 })).zoomPercent).toBe(
      140,
    );
  });
});
