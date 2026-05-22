// 粘贴快捷键判定。命中时调用方不要 preventDefault,让浏览器继续派发
// ClipboardEvent("paste");pane 的 paste listener 再把文本发给后端。

/// 是否应交给浏览器默认 paste 路径。这里只判定常见终端 / 浏览器粘贴键:
/// Ctrl/Cmd+V、Ctrl/Cmd+Shift+V、Shift+Insert。
export function shouldBrowserHandlePasteShortcut(e: KeyboardEvent): boolean {
  if (e.altKey) return false;
  if (isVKey(e)) return e.ctrlKey || e.metaKey;
  return isShiftInsert(e);
}

function isVKey(e: KeyboardEvent): boolean {
  return e.code === "KeyV" || e.key.toLowerCase() === "v";
}

function isShiftInsert(e: KeyboardEvent): boolean {
  return (
    e.key === "Insert" &&
    e.code === "Insert" &&
    e.shiftKey &&
    !e.ctrlKey &&
    !e.metaKey
  );
}
