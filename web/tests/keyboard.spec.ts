// KeyboardEvent → ClientMessage 的纯映射测试。
//
// 用 jsdom 提供的 KeyboardEvent 构造器,验证特殊键 / 修饰符 / 印刷字符 /
// IME 抑制等边界。

import { describe, expect, it } from "vitest";
import { encodeKeyboardEvent } from "../src/input/keyboard";

function ke(init: KeyboardEventInit): KeyboardEvent {
  // jsdom KeyboardEvent constructor 接受标准 init。
  return new KeyboardEvent("keydown", init);
}

describe("encodeKeyboardEvent", () => {
  it("maps Enter / Tab / Backspace / Escape", () => {
    expect(encodeKeyboardEvent(ke({ key: "Enter" }))).toEqual({
      type: "key",
      key: { type: "enter" },
    });
    expect(encodeKeyboardEvent(ke({ key: "Tab" }))).toEqual({
      type: "key",
      key: { type: "tab" },
    });
    expect(encodeKeyboardEvent(ke({ key: "Backspace" }))).toEqual({
      type: "key",
      key: { type: "backspace" },
    });
    expect(encodeKeyboardEvent(ke({ key: "Escape" }))).toEqual({
      type: "key",
      key: { type: "escape" },
    });
  });

  it("maps arrow keys", () => {
    expect(encodeKeyboardEvent(ke({ key: "ArrowUp" }))).toEqual({
      type: "key",
      key: { type: "up" },
    });
    expect(encodeKeyboardEvent(ke({ key: "ArrowDown" }))).toEqual({
      type: "key",
      key: { type: "down" },
    });
  });

  it("maps F1..F12 with n field", () => {
    expect(encodeKeyboardEvent(ke({ key: "F1" }))).toEqual({
      type: "key",
      key: { type: "f", n: 1 },
    });
    expect(encodeKeyboardEvent(ke({ key: "F12" }))).toEqual({
      type: "key",
      key: { type: "f", n: 12 },
    });
  });

  it("drops F13+", () => {
    expect(encodeKeyboardEvent(ke({ key: "F13" }))).toBeNull();
  });

  it("emits char for printable keys", () => {
    expect(encodeKeyboardEvent(ke({ key: "a" }))).toEqual({
      type: "key",
      key: { type: "char", value: "a" },
    });
    expect(encodeKeyboardEvent(ke({ key: "A", shiftKey: true }))).toEqual({
      type: "key",
      key: { type: "char", value: "A" },
      mods: { ctrl: false, alt: false, shift: true },
    });
  });

  it("ctrl-c carries ctrl mod with lowercase char", () => {
    expect(
      encodeKeyboardEvent(ke({ key: "c", ctrlKey: true })),
    ).toEqual({
      type: "key",
      key: { type: "char", value: "c" },
      mods: { ctrl: true, alt: false, shift: false },
    });
  });

  it("omits mods when none pressed", () => {
    const out = encodeKeyboardEvent(ke({ key: "x" }));
    expect(out).toEqual({ type: "key", key: { type: "char", value: "x" } });
    expect((out as { mods?: unknown }).mods).toBeUndefined();
  });

  it("drops bare modifier key presses", () => {
    expect(encodeKeyboardEvent(ke({ key: "Shift" }))).toBeNull();
    expect(encodeKeyboardEvent(ke({ key: "Control" }))).toBeNull();
    expect(encodeKeyboardEvent(ke({ key: "Alt" }))).toBeNull();
    expect(encodeKeyboardEvent(ke({ key: "Meta" }))).toBeNull();
    expect(encodeKeyboardEvent(ke({ key: "Dead" }))).toBeNull();
  });

  it("drops IME composing events", () => {
    expect(
      encodeKeyboardEvent(ke({ key: "a", isComposing: true } as KeyboardEventInit)),
    ).toBeNull();
    expect(encodeKeyboardEvent(ke({ key: "Process" }))).toBeNull();
  });

  it("does not expose meta as ctrl", () => {
    const out = encodeKeyboardEvent(ke({ key: "c", metaKey: true }));
    // Cmd+C 走默认浏览器复制路径 ── 我们标记没有 mods,后端会编 'c' 字面。
    // 实际 App 组件会监听 copy 事件优先处理,这里只断言 ctrl 没被错误抬起。
    expect(out).toEqual({
      type: "key",
      key: { type: "char", value: "c" },
    });
  });
});
