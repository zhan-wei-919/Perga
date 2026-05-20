// Workspace 级键盘快捷键的纯匹配器:DOM KeyboardEvent → WorkspaceAction。
//
// 只做「这个按键是不是 workspace 快捷键」的判定,不做副作用 ── app 根的 capture
// 阶段监听器拿到非 null 结果才 preventDefault + 调 workspace 方法(见 app.tsx)。
// 抽成纯函数是为了能脱离 DOM 直接单测。
//
// 全部快捷键都在 `Ctrl+Shift+<key>` 这一族(focus 移动除外,走 Alt+方向键)。
// 原因:纯 Web 开发态下,浏览器 chrome 会**抢占且不可 preventDefault**
// `Ctrl+T/W/N/Tab` 和 `Ctrl+数字`;但它不碰 `Ctrl+Shift+数字` / `Ctrl+Shift+X`
// 这类组合。进 Tauri(Phase 6,无浏览器 chrome)后这层约束消失,届时可重排。
//
// 用 `e.code`(物理键位)而非 `e.key`:跨键盘布局稳健,且不受 Shift 改变
// `e.key` 大小写的影响。

import type { SplitAxis } from "../state/pane_tree";

export type WorkspaceAction =
  | { kind: "split"; axis: SplitAxis }
  | { kind: "close" }
  | { kind: "newTab" }
  | { kind: "switchTab"; index: number } // 0-based;越界由 workspace clamp
  | { kind: "nextTab" }
  | { kind: "focus"; dir: "up" | "down" | "left" | "right" };

/** 命中返回对应 action,否则 null(交还给 focused pane 当终端输入)。 */
export function matchWorkspaceShortcut(e: KeyboardEvent): WorkspaceAction | null {
  // metaKey(Cmd / Win 键)留给操作系统,不抢。
  if (e.metaKey) return null;

  // Ctrl+Shift+<key>:全部 tab / pane 操作。
  if (e.ctrlKey && e.shiftKey && !e.altKey) {
    switch (e.code) {
      case "KeyD":
        return { kind: "split", axis: "vertical" };
      case "KeyE":
        return { kind: "split", axis: "horizontal" };
      case "KeyX":
        return { kind: "close" };
      case "Enter":
        return { kind: "newTab" };
      case "ArrowRight":
        return { kind: "nextTab" };
    }
    // Ctrl+Shift+1..9:直接切到第 N 个 tab。
    const digit = digitFromCode(e.code);
    if (digit !== null) return { kind: "switchTab", index: digit - 1 };
    return null;
  }

  // Alt+方向键:移焦到空间相邻 pane。
  if (e.altKey && !e.ctrlKey && !e.shiftKey) {
    switch (e.code) {
      case "ArrowUp":
        return { kind: "focus", dir: "up" };
      case "ArrowDown":
        return { kind: "focus", dir: "down" };
      case "ArrowLeft":
        return { kind: "focus", dir: "left" };
      case "ArrowRight":
        return { kind: "focus", dir: "right" };
      default:
        return null;
    }
  }

  return null;
}

/** "Digit1".."Digit9" → 1..9。Digit0 不映射(没有第 0 个 tab)。 */
function digitFromCode(code: string): number | null {
  const m = /^Digit([1-9])$/.exec(code);
  return m ? Number(m[1]) : null;
}
