// 缩放快捷键匹配器单测(zoom_shortcuts.ts)。

import { describe, expect, it } from "vitest";

import { matchZoomShortcut } from "../src/input/zoom_shortcuts";

function ke(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

describe("matchZoomShortcut", () => {
  it("Ctrl+Shift+= → zoomIn", () => {
    expect(
      matchZoomShortcut(ke({ code: "Equal", ctrlKey: true, shiftKey: true })),
    ).toEqual({ kind: "zoomIn" });
  });

  it("Ctrl+Shift+- → zoomOut", () => {
    expect(
      matchZoomShortcut(ke({ code: "Minus", ctrlKey: true, shiftKey: true })),
    ).toEqual({ kind: "zoomOut" });
  });

  it("Ctrl+Shift+0 → zoomReset", () => {
    expect(
      matchZoomShortcut(ke({ code: "Digit0", ctrlKey: true, shiftKey: true })),
    ).toEqual({ kind: "zoomReset" });
  });

  it("falls back to key when Android WebView omits code", () => {
    expect(matchZoomShortcut(ke({ key: "+", ctrlKey: true, shiftKey: true }))).toEqual({
      kind: "zoomIn",
    });
    expect(matchZoomShortcut(ke({ key: "-", ctrlKey: true, shiftKey: true }))).toEqual({
      kind: "zoomOut",
    });
    expect(matchZoomShortcut(ke({ key: "0", ctrlKey: true, shiftKey: true }))).toEqual({
      kind: "zoomReset",
    });
  });

  it("裸 Ctrl+=(无 Shift)→ null —— 让位浏览器缩放", () => {
    expect(matchZoomShortcut(ke({ code: "Equal", ctrlKey: true }))).toBeNull();
  });

  it("缺 Ctrl → null", () => {
    expect(matchZoomShortcut(ke({ code: "Equal", shiftKey: true }))).toBeNull();
  });

  it("含 Alt → null", () => {
    expect(
      matchZoomShortcut(
        ke({ code: "Equal", ctrlKey: true, shiftKey: true, altKey: true }),
      ),
    ).toBeNull();
  });

  it("metaKey → null", () => {
    expect(
      matchZoomShortcut(
        ke({ code: "Equal", ctrlKey: true, shiftKey: true, metaKey: true }),
      ),
    ).toBeNull();
  });

  it("其它键 → null", () => {
    expect(
      matchZoomShortcut(ke({ code: "KeyA", ctrlKey: true, shiftKey: true })),
    ).toBeNull();
  });
});
