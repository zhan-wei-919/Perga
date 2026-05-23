// 缩放快捷键的纯匹配器:DOM KeyboardEvent → ZoomAction。
//
// 用 `Ctrl+Shift+=` / `Ctrl+Shift+-` / `Ctrl+Shift+0` 而非裸 `Ctrl+=/-/0`:
// 后者是浏览器页面缩放加速键,Chrome 不让 `preventDefault` 压住(同
// `workspace_shortcuts.ts` 记录的 chrome 约束)。设置面板的滑块始终可用,
// 键盘只是快捷方式。进 Tauri(Phase 6,无浏览器 chrome)后可再加裸键。
//
// 优先用 `e.code`(物理键位):跨布局稳健,不受 Shift 改 `e.key` 大小写影响。
// Android WebView / 物理键盘组合有时不给稳定 code,所以做 `e.key` fallback。

export type ZoomAction = { kind: "zoomIn" | "zoomOut" | "zoomReset" };

/** 命中返回对应 action,否则 null(交还给 focused pane 当终端输入)。 */
export function matchZoomShortcut(e: KeyboardEvent): ZoomAction | null {
  if (e.metaKey) return null;
  if (!e.ctrlKey || !e.shiftKey || e.altKey) return null;
  switch (shortcutKey(e)) {
    case "Equal":
      return { kind: "zoomIn" };
    case "Minus":
      return { kind: "zoomOut" };
    case "Digit0":
      return { kind: "zoomReset" };
    default:
      return null;
  }
}

function shortcutKey(e: KeyboardEvent): string {
  if (e.code) return e.code;
  if (e.key === "=" || e.key === "+") return "Equal";
  if (e.key === "-" || e.key === "_") return "Minus";
  if (e.key === "0" || e.key === ")") return "Digit0";
  return e.key;
}
