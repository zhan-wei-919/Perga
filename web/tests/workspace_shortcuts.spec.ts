// workspace_shortcuts 纯匹配器单测。

import { describe, expect, it } from "vitest";

import { matchWorkspaceShortcut } from "../src/input/workspace_shortcuts";

const key = (code: string, mods: Partial<KeyboardEventInit> = {}): KeyboardEvent =>
  new KeyboardEvent("keydown", { code, ...mods });

const ctrlShift = { ctrlKey: true, shiftKey: true };

describe("matchWorkspaceShortcut", () => {
  it("maps Ctrl+Shift+D/E to splits", () => {
    expect(matchWorkspaceShortcut(key("KeyD", ctrlShift))).toEqual({
      kind: "split",
      axis: "vertical",
    });
    expect(matchWorkspaceShortcut(key("KeyE", ctrlShift))).toEqual({
      kind: "split",
      axis: "horizontal",
    });
  });

  it("maps Ctrl+Shift+X to close pane", () => {
    expect(matchWorkspaceShortcut(key("KeyX", ctrlShift))).toEqual({
      kind: "close",
    });
  });

  it("maps Ctrl+Shift+Enter to new tab", () => {
    expect(matchWorkspaceShortcut(key("Enter", ctrlShift))).toEqual({
      kind: "newTab",
    });
  });

  it("maps Ctrl+Shift+digit to switchTab (0-based)", () => {
    expect(matchWorkspaceShortcut(key("Digit1", ctrlShift))).toEqual({
      kind: "switchTab",
      index: 0,
    });
    expect(matchWorkspaceShortcut(key("Digit9", ctrlShift))).toEqual({
      kind: "switchTab",
      index: 8,
    });
  });

  it("maps Ctrl+Shift+ArrowRight to nextTab", () => {
    expect(matchWorkspaceShortcut(key("ArrowRight", ctrlShift))).toEqual({
      kind: "nextTab",
    });
  });

  it("maps Alt+Arrow to focus moves", () => {
    expect(matchWorkspaceShortcut(key("ArrowLeft", { altKey: true }))).toEqual({
      kind: "focus",
      dir: "left",
    });
    expect(matchWorkspaceShortcut(key("ArrowRight", { altKey: true }))).toEqual({
      kind: "focus",
      dir: "right",
    });
    expect(matchWorkspaceShortcut(key("ArrowUp", { altKey: true }))).toEqual({
      kind: "focus",
      dir: "up",
    });
    expect(matchWorkspaceShortcut(key("ArrowDown", { altKey: true }))).toEqual({
      kind: "focus",
      dir: "down",
    });
  });

  it("returns null for non-shortcut keys", () => {
    expect(matchWorkspaceShortcut(key("KeyA"))).toBeNull();
    // Ctrl+D(无 Shift)是终端输入,不是 split。
    expect(matchWorkspaceShortcut(key("KeyD", { ctrlKey: true }))).toBeNull();
    // Ctrl+数字(无 Shift)是浏览器切标签页,我们不接。
    expect(matchWorkspaceShortcut(key("Digit1", { ctrlKey: true }))).toBeNull();
    // 未映射的 Ctrl+Shift 组合。
    expect(matchWorkspaceShortcut(key("KeyZ", ctrlShift))).toBeNull();
    // Ctrl+Shift+Digit0 没有对应 tab。
    expect(matchWorkspaceShortcut(key("Digit0", ctrlShift))).toBeNull();
    // 裸方向键(无 Alt)进 PTY。
    expect(matchWorkspaceShortcut(key("ArrowLeft"))).toBeNull();
  });

  it("ignores combinations with metaKey", () => {
    expect(
      matchWorkspaceShortcut(key("KeyD", { ...ctrlShift, metaKey: true })),
    ).toBeNull();
  });
});
