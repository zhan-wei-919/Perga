// 浏览器 mouse / wheel 事件 → 后端 ClientMessage(`mouse`)的纯逻辑。
//
// 终端 mouse reporting 开启后,鼠标默认属于 TUI(vim / tmux / lazygit / htop)。
// 但用户随时要复制文本,所以保留一条 `Shift+Drag` 的强制前端选择路径 ──
// 这是 WezTerm / iTerm2 已经形成的肌肉记忆,沿用避免重学。
//
// 这一层只做语义化决定,不持有 DOM、不发消息。具体调度由 pane_leaf.tsx
// 负责;具体怎么编成 PTY 字节(SGR / X10)留给后端 ── 后端知道当前 modes,
// 前端不该重复实现一份。

import type { MouseReporting } from "../state/protocol";
import type {
  ClientMessage,
  Modifiers,
  MouseButton,
  MouseKind,
} from "../state/wire";
import type { SelectionPoint } from "./terminal_selection";

/// 路由结果。`tui` = 编码发给后端;`selection` = 走前端选择/滚动路径;
/// `ignore` = 当前 mode 不收这种事件,丢弃。
export type MouseRouting = "tui" | "selection" | "ignore";

/// `decideMouseRouting` 的事件分类。`click` 涵盖 press/release/wheel ──
/// 所有 `mouse_reporting !== "off"` 模式都接受;只有 drag / motion 需要按
/// mode 进一步过滤,对应后端 `encode_mouse` 的同一份 gating 表。
export type MouseEventKind = "click" | "drag" | "motion";

/// 把鼠标事件分流到 TUI 或前端 selection。`Shift` 永远抢回前端,
/// 不论后端 mouse mode 处于什么状态。
export function decideMouseRouting(args: {
  mouseReporting: MouseReporting;
  kind: MouseEventKind;
  shiftKey: boolean;
}): MouseRouting {
  const { mouseReporting, kind, shiftKey } = args;

  if (mouseReporting === "off") return "selection";
  if (shiftKey) return "selection";

  switch (kind) {
    case "click":
      // press / release / wheel:任意非 Off 模式都上报。
      return "tui";
    case "drag":
      // Normal(?1000)只报 press/release,Button(?1002)/Any(?1003)才报 drag。
      return mouseReporting === "normal" ? "ignore" : "tui";
    case "motion":
      // 只有 Any(?1003)才报无按键移动。
      return mouseReporting === "any" ? "tui" : "ignore";
  }
}

/// DOM `MouseEvent.button` → wire `MouseButton`。返回 null 表示当前不支持
/// 该按键(forward / back 键暂不映射,留给浏览器历史导航)。
export function pointerButton(button: number): MouseButton | null {
  switch (button) {
    case 0:
      return "left";
    case 1:
      return "middle";
    case 2:
      return "right";
    default:
      return null;
  }
}

/// 从 DOM 事件收集修饰符。三键都没按时返回 undefined,wire 形状更紧凑。
export function collectMouseMods(e: {
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): Modifiers | undefined {
  if (!e.ctrlKey && !e.altKey && !e.shiftKey) return undefined;
  return {
    ctrl: e.ctrlKey || undefined,
    alt: e.altKey || undefined,
    shift: e.shiftKey || undefined,
  };
}

/// 把 SelectionPoint(统一 display row 坐标 + cell 边界 col)换算成
/// 1-based 终端 cell 坐标。
///
/// 默认严格模式:点击落在历史区域时返回 null,调用方丢弃事件。press 阶段
/// 应该用严格模式 ── 在历史里点击意味着用户在交互历史,不该启动 TUI mouse。
///
/// `clampToActiveGrid: true`:把 row 钳制到 active grid 上下界,永远返回非
/// null(只要 pointForEvent 给出 SelectionPoint)。drag / release 阶段应该
/// 用钳制模式 ── 一旦 TUI 接管了 pointer,所有后续事件必须能映射到一个 cell,
/// 否则 release 丢失,TUI 进入「按键一直按着」的卡死状态。
export function selectionPointToCell(
  pt: SelectionPoint,
  layout: {
    historyLen: number;
    gridRows: number;
    cols: number;
    altScreen: boolean;
  },
  options?: { clampToActiveGrid?: boolean },
): { row: number; col: number } | null {
  const activeRowStart = layout.altScreen ? 0 : layout.historyLen;
  const activeRowEnd = activeRowStart + layout.gridRows;
  let rowZero: number;
  if (pt.row < activeRowStart) {
    if (!options?.clampToActiveGrid) return null;
    rowZero = 0;
  } else if (pt.row >= activeRowEnd) {
    if (!options?.clampToActiveGrid) return null;
    rowZero = layout.gridRows - 1;
  } else {
    rowZero = pt.row - activeRowStart;
  }

  // selection col 在 [0, cols] 上,可能等于 cols(行尾右侧)── 上报时夹到
  // 最后一列,后端 NonZeroU16 要求 >= 1。
  const colZero = Math.max(0, Math.min(layout.cols - 1, pt.col));
  return { row: rowZero + 1, col: colZero + 1 };
}

/// 构造 ClientMessage。col/row 必须 1-based 且 >= 1,否则返回 null
/// (后端 schema 用 NonZeroU16,负责的边界验证在这一处)。
export function buildMouseMessage(args: {
  kind: MouseKind;
  col: number;
  row: number;
  mods?: Modifiers;
}): ClientMessage | null {
  if (args.col < 1 || args.row < 1) return null;
  return {
    type: "mouse",
    kind: args.kind,
    col: args.col,
    row: args.row,
    mods: args.mods,
  };
}

/// 累加 wheel deltaY,按 cellH 步长出 step 数。`deltaMode === 0`(像素)
/// 走累加器,1(行)/ 2(页)直接当作整数 step。返回 `{ steps, remainder }`,
/// remainder 写回调用方持有的累加器。正 = 向下,负 = 向上。
export function wheelLineSteps(args: {
  accumulator: number;
  deltaY: number;
  deltaMode: number;
  cellHeight: number;
}): { steps: number; remainder: number } {
  if (args.deltaMode !== 0) {
    // 行 / 页 模式:浏览器已经按行给,不该再累加像素。直接取整。
    return { steps: Math.trunc(args.deltaY), remainder: 0 };
  }
  const next = args.accumulator + args.deltaY;
  if (Math.abs(next) < args.cellHeight) {
    return { steps: 0, remainder: next };
  }
  const steps = Math.trunc(next / args.cellHeight);
  const remainder = next - steps * args.cellHeight;
  return { steps, remainder };
}
