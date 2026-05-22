// Ctrl/Cmd+C 复制 vs 终端 SIGINT 的判定测试。

import { afterEach, describe, expect, it } from "vitest";

import { shouldBrowserHandleCopyShortcut } from "../src/input/copy_shortcuts";

const copyKey = (mods: Partial<KeyboardEventInit> = {}): KeyboardEvent =>
  new KeyboardEvent("keydown", { key: "c", ...mods });

function selectText(node: Node): void {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

describe("shouldBrowserHandleCopyShortcut", () => {
  it("lets Ctrl+C reach the terminal when there is no selection", () => {
    const root = document.createElement("div");
    document.body.append(root);

    expect(
      shouldBrowserHandleCopyShortcut(copyKey({ ctrlKey: true }), root),
    ).toBe(false);
  });

  it("uses browser copy for Ctrl+C when text is selected inside the pane", () => {
    const root = document.createElement("div");
    const text = document.createElement("span");
    text.textContent = "selected output";
    root.append(text);
    document.body.append(root);
    selectText(text);

    expect(
      shouldBrowserHandleCopyShortcut(copyKey({ ctrlKey: true }), root),
    ).toBe(true);
  });

  it("ignores stale selections outside the current pane", () => {
    const root = document.createElement("div");
    const other = document.createElement("div");
    other.textContent = "old selection";
    document.body.append(root, other);
    selectText(other);

    expect(
      shouldBrowserHandleCopyShortcut(copyKey({ ctrlKey: true }), root),
    ).toBe(false);
  });

  it("does not treat an empty non-collapsed range as copyable text", () => {
    const root = document.createElement("div");
    const empty = document.createElement("span");
    root.append(empty);
    document.body.append(root);
    const range = document.createRange();
    range.setStartBefore(empty);
    range.setEndAfter(empty);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(
      shouldBrowserHandleCopyShortcut(copyKey({ ctrlKey: true }), root),
    ).toBe(false);
  });

  it("keeps Cmd+C in the browser instead of sending a literal c", () => {
    const root = document.createElement("div");
    document.body.append(root);

    expect(
      shouldBrowserHandleCopyShortcut(copyKey({ metaKey: true }), root),
    ).toBe(true);
  });

  it("does not intercept modified copy-like chords", () => {
    const root = document.createElement("div");
    const text = document.createElement("span");
    text.textContent = "selected output";
    root.append(text);
    document.body.append(root);
    selectText(text);

    expect(
      shouldBrowserHandleCopyShortcut(
        copyKey({ ctrlKey: true, shiftKey: true }),
        root,
      ),
    ).toBe(false);
    expect(
      shouldBrowserHandleCopyShortcut(copyKey({ ctrlKey: true, altKey: true }), root),
    ).toBe(false);
  });
});
