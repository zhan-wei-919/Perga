// Platform 探测:三个 fallback 层各自的输出。
//
// jsdom 默认不带 `__TAURI_INTERNALS__`,等价"浏览器 dev"形态。
// URL flag 覆盖 + Tauri 检测 各跑一遍。

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectPlatform, isTauri } from "../src/util/platform";

describe("isTauri", () => {
  it("默认 jsdom 环境 = false", () => {
    expect(isTauri()).toBe(false);
  });

  it("窗口上挂 `__TAURI_INTERNALS__` → true", () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      expect(isTauri()).toBe(true);
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    }
  });
});

describe("detectPlatform", () => {
  let originalLocation: Location;

  beforeEach(() => {
    originalLocation = window.location;
  });
  afterEach(() => {
    // 恢复 location 用 defineProperty(jsdom 不允许直接 reassign)。
    Object.defineProperty(window, "location", {
      value: originalLocation,
      writable: true,
    });
  });

  function withSearch(search: string): void {
    Object.defineProperty(window, "location", {
      value: { ...originalLocation, search },
      writable: true,
    });
  }

  it("`?platform=mobile` URL flag 强制 mobile", async () => {
    withSearch("?platform=mobile");
    const p = await detectPlatform();
    expect(p).toEqual({ kind: "mobile", isTauri: false });
  });

  it("`?platform=desktop` URL flag 强制 desktop", async () => {
    withSearch("?platform=desktop");
    const p = await detectPlatform();
    expect(p).toEqual({ kind: "desktop", isTauri: false });
  });

  it("默认浏览器 = desktop / 非 Tauri", async () => {
    withSearch("");
    const p = await detectPlatform();
    expect(p).toEqual({ kind: "desktop", isTauri: false });
  });
});
