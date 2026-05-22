// Ctrl/Cmd+C 在终端里有双重语义:有选区时复制,否则 Ctrl+C 应发 SIGINT。
//
// 这个判断必须限定到当前 pane:浏览器 selection 是全局状态,如果只看
// `window.getSelection().isCollapsed`,页面里残留的旧选区会把终端 Ctrl+C
// 永久挡掉。

export function shouldBrowserHandleCopyShortcut(
  e: KeyboardEvent,
  root: HTMLElement,
): boolean {
  if (!isPlainCopyShortcut(e)) return false;
  // Cmd+C 是浏览器/系统复制语义,不要降级成向 PTY 发送字面 c。
  if (e.metaKey) return true;
  return hasCopyableSelectionInside(root);
}

function isPlainCopyShortcut(e: KeyboardEvent): boolean {
  return (
    (e.ctrlKey || e.metaKey) &&
    !e.shiftKey &&
    !e.altKey &&
    (e.key === "c" || e.key === "C")
  );
}

function hasCopyableSelectionInside(root: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.toString().length === 0) {
    return false;
  }

  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    if (range.collapsed || range.toString().length === 0) continue;
    if (rangeIntersectsElement(range, root)) return true;
  }
  return false;
}

function rangeIntersectsElement(range: Range, root: HTMLElement): boolean {
  try {
    if (range.intersectsNode(root)) return true;
  } catch {
    // Some DOM implementations throw for detached nodes; fall through to the
    // ancestor check below.
  }

  const ancestor = range.commonAncestorContainer;
  const node =
    ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentNode;
  return node !== null && root.contains(node);
}
