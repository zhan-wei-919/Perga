// 粘贴快捷键判定测试。命中时让浏览器默认 paste 继续发生,
// pane 的 paste listener 再把剪贴板文本发给后端。

import { describe, expect, it } from "vitest";

import { shouldBrowserHandlePasteShortcut } from "../src/input/paste_shortcuts";

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

describe("shouldBrowserHandlePasteShortcut", () => {
  it("lets Ctrl+V trigger the browser paste event", () => {
    expect(
      shouldBrowserHandlePasteShortcut(
        key({ key: "v", code: "KeyV", ctrlKey: true }),
      ),
    ).toBe(true);
  });

  it("lets Ctrl+Shift+V trigger the browser paste event", () => {
    expect(
      shouldBrowserHandlePasteShortcut(
        key({ key: "V", code: "KeyV", ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(true);
  });

  it("lets Cmd+V trigger the browser paste event", () => {
    expect(
      shouldBrowserHandlePasteShortcut(
        key({ key: "v", code: "KeyV", metaKey: true }),
      ),
    ).toBe(true);
  });

  it("lets Shift+Insert trigger the browser paste event", () => {
    expect(
      shouldBrowserHandlePasteShortcut(
        key({ key: "Insert", code: "Insert", shiftKey: true }),
      ),
    ).toBe(true);
  });

  it("ignores modified paste-like chords", () => {
    expect(
      shouldBrowserHandlePasteShortcut(
        key({ key: "v", code: "KeyV", ctrlKey: true, altKey: true }),
      ),
    ).toBe(false);
    expect(
      shouldBrowserHandlePasteShortcut(
        key({ key: "Insert", code: "Insert", ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(false);
  });
});
