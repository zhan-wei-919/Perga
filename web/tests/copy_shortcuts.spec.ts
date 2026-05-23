// Ctrl/Cmd+C 复制 vs 终端 SIGINT 的快捷键判定测试。

import { describe, expect, it } from "vitest";

import { isPlainCopyShortcut } from "../src/input/copy_shortcuts";

const key = (mods: Partial<KeyboardEventInit> = {}): KeyboardEvent =>
  new KeyboardEvent("keydown", { key: "c", ...mods });

describe("isPlainCopyShortcut", () => {
  it("accepts Ctrl+C and Cmd+C", () => {
    expect(isPlainCopyShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isPlainCopyShortcut(key({ metaKey: true }))).toBe(true);
  });

  it("accepts upper-case C", () => {
    expect(
      isPlainCopyShortcut(new KeyboardEvent("keydown", { key: "C", ctrlKey: true })),
    ).toBe(true);
  });

  it("rejects modified copy-like chords", () => {
    expect(isPlainCopyShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isPlainCopyShortcut(key({ ctrlKey: true, altKey: true }))).toBe(false);
  });

  it("rejects non-copy keys", () => {
    expect(
      isPlainCopyShortcut(new KeyboardEvent("keydown", { key: "x", ctrlKey: true })),
    ).toBe(false);
  });
});
