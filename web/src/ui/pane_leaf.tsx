// 一个终端 pane:把一个 `LeafSession` 装配成可见、可输入的终端。
//
// 布局:一个 `overflow-y:auto` 滚动容器,里面是 `[虚拟 DOM 历史][活动区 DOM grid]`。
// 历史(scrollback)和活动区都走 DOM 文本渲染,但活动区仍保持终端 cell grid 语义。
//
// session 资源(socket / store)由 workspace 拥有,本组件只消费 —— 组件 unmount
// **不**关 socket(split 重建树时 Solid 可能 remount 本组件,session 必须存活)。

import {
  Component,
  For,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";

import {
  copyTextToClipboard,
  isPlainCopyShortcut,
} from "../input/copy_shortcuts";
import {
  compositionCommitMessage,
  inputCommitMessage,
} from "../input/composition";
import { encodeKeyboardEvent } from "../input/keyboard";
import {
  buildMouseMessage,
  collectMouseMods,
  decideMouseRouting,
  pointerButton,
  selectionPointToCell,
  wheelLineSteps,
} from "../input/mouse";
import { shouldBrowserHandlePasteShortcut } from "../input/paste_shortcuts";
import { observeContainerResize } from "../input/resize";
import {
  clearBrowserSelection,
  isCollapsedSelection,
  pointFromContentOffset,
  selectedText,
  selectionRects,
  terminalDisplayRowCount,
  type SelectionPoint,
  type TerminalSelection,
} from "../input/terminal_selection";
import type { MouseButton, MouseKind } from "../state/wire";
import { GridDom } from "../render/grid_dom";
import { HISTORY_GUTTER_PX, HistoryView } from "../render/history_view";
import { cellsForBox, measureCell, type CellMetrics } from "../render/metrics";
import { useSettings } from "../state/settings_context";
import type { LeafSession } from "../state/workspace";

/// Pane 四边留白 ── 终端文字与窗口边之间的呼吸量。wezterm 默认 8px,
/// 这里保持一致。仅作视觉留白,不影响 cellsForBox 的网格计算(那里读
/// gridHost 的实际 rect,padding 自然反映在 rect 尺寸里)。
const PANE_PADDING_PX = 8;

export type PaneLeafProps = {
  session: LeafSession;
  /** 是否是 active tab 的 focused leaf。 */
  focused: boolean;
  /** 点击 / 获得 DOM 焦点时请求 workspace 把焦点指到本 leaf。 */
  onFocusRequest: () => void;
};

/// 单个终端 pane。容器自身可聚焦(`tabindex=0`),终端输入监听挂在容器上。
export const PaneLeaf: Component<PaneLeafProps> = (props) => {
  // session 在本组件生命周期内恒定 ── 一次性捕获,绝不在 onMount / 回调里走
  // `props.session` 响应式 getter:组件卸载时该 leaf 可能已 dispose,重算会抛。
  const session = props.session;
  const settings = useSettings();
  let containerRef: HTMLDivElement | undefined;
  let gridHostRef: HTMLDivElement | undefined;
  let inputProxyRef: HTMLTextAreaElement | undefined;

  // 虚拟历史列表要据滚动位置 / 视口高算可见窗口。
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportH, setViewportH] = createSignal(0);
  const [cellMetrics, setCellMetrics] = createSignal<CellMetrics | null>(null);
  const [selection, setSelection] = createSignal<TerminalSelection | null>(null);

  // 自动滚到底:有新内容时把活动区 grid 滚进视野;用户手动上滚后暂停,
  // 滚回底部恢复。标准终端行为。
  let stickToBottom = true;
  let scrollRaf: number | undefined;
  const scrollToBottom = (): void => {
    if (scrollRaf !== undefined) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = undefined;
      if (containerRef && stickToBottom) {
        containerRef.scrollTop = containerRef.scrollHeight;
      }
    });
  };

  const displayRowCount = (): number =>
    terminalDisplayRowCount(
      session.store.state.historyLen,
      session.store.state.size.rows,
      session.store.state.modes.alt_screen,
    );

  const textLeftPx = (): number =>
    session.store.state.modes.alt_screen ? 0 : HISTORY_GUTTER_PX;

  const inputProxyStyle = createMemo(() => {
    const metrics = cellMetrics();
    if (!metrics) return hiddenInputProxyStyle(0, 0, 1, 1);
    const cursor = session.store.state.cursor;
    const displayRow = session.store.state.modes.alt_screen
      ? cursor.row
      : session.store.state.historyLen + cursor.row;
    // absolute 子元素相对 container 的 padding box;PANE_PADDING_PX 把
    // proxy 平移到 content area,与块流里的 HistoryView/gridHost 起点对齐。
    return hiddenInputProxyStyle(
      PANE_PADDING_PX + textLeftPx() + cursor.col * metrics.cellW,
      PANE_PADDING_PX + displayRow * metrics.cellH,
      metrics.cellW,
      metrics.cellH,
      metrics.fontFamily,
      metrics.fontSize,
    );
  });

  const overlayRects = createMemo(() => {
    const metrics = cellMetrics();
    const current = selection();
    if (!metrics || !current) return [];
    const visibleStartRow = Math.floor(scrollTop() / metrics.cellH) - 1;
    const visibleEndRow =
      Math.ceil((scrollTop() + viewportH()) / metrics.cellH) + 1;
    return selectionRects(current, {
      rowCount: displayRowCount(),
      cols: session.store.state.size.cols,
      cellW: metrics.cellW,
      cellH: metrics.cellH,
      textLeftPx: textLeftPx(),
      visibleStartRow,
      visibleEndRow,
    });
  });

  // 接受 MouseEvent(PointerEvent / WheelEvent 都继承自它)── wheel 路径
  // 需要复用同一坐标换算。
  //
  // box.left/top 是 container 的 border 外沿;PANE_PADDING_PX 让换算回到
  // content area 起点,与块流里 HistoryView / gridHost 的渲染原点一致。
  const pointForEvent = (
    e: MouseEvent,
    anchor?: SelectionPoint,
  ): SelectionPoint | null => {
    const metrics = cellMetrics();
    const el = containerRef;
    if (!metrics || !el) return null;
    const box = el.getBoundingClientRect();
    return pointFromContentOffset(
      e.clientX - box.left - PANE_PADDING_PX,
      e.clientY - box.top + el.scrollTop - PANE_PADDING_PX,
      {
        rowCount: displayRowCount(),
        cols: session.store.state.size.cols,
        cellW: metrics.cellW,
        cellH: metrics.cellH,
        textLeftPx: textLeftPx(),
      },
      anchor,
    );
  };

  // 把 SelectionPoint 转换为 1-based 终端 cell 坐标。
  // `clamp` 控制点击落在历史 / 越界时的行为:press 用严格模式(返回 null),
  // drag / release 用 clamp(返回钳制到 active grid 边界的 cell)。
  const cellForPoint = (
    point: SelectionPoint,
    clamp: boolean = false,
  ): { row: number; col: number } | null =>
    selectionPointToCell(
      point,
      {
        historyLen: session.store.state.historyLen,
        gridRows: session.store.state.size.rows,
        cols: session.store.state.size.cols,
        altScreen: session.store.state.modes.alt_screen,
      },
      { clampToActiveGrid: clamp },
    );

  const sendMouseCell = (
    e: MouseEvent,
    cell: { row: number; col: number },
    kind: MouseKind,
  ): boolean => {
    const msg = buildMouseMessage({
      kind,
      col: cell.col,
      row: cell.row,
      mods: collectMouseMods(e),
    });
    if (!msg) return false;
    session.send(msg);
    return true;
  };

  const sendMouseAt = (
    e: MouseEvent,
    point: SelectionPoint,
    kind: MouseKind,
  ): boolean => {
    const cell = cellForPoint(point);
    if (!cell) return false;
    return sendMouseCell(e, cell, kind);
  };

  const copySelection = (): void => {
    const text = selectedText(selection(), {
      history: session.store.history,
      grid: session.store.grid,
      historyLen: session.store.state.historyLen,
      gridRows: session.store.state.size.rows,
      cols: session.store.state.size.cols,
      altScreen: session.store.state.modes.alt_screen,
    });
    if (text.length === 0) return;
    void copyTextToClipboard(text).catch((err) => {
      console.warn("terminal.copy_failed", err);
    });
  };

  const focusInputProxy = (): void => {
    const target = inputProxyRef ?? containerRef;
    // DIAGNOSTIC (IME 调试,定位后删):看真实落到哪个元素。
    console.log("[ime.focus]", {
      hasProxyRef: !!inputProxyRef,
      targetTag: target?.tagName,
      activeBefore: (document.activeElement as HTMLElement | null)?.tagName,
    });
    target?.focus({ preventScroll: true });
    console.log("[ime.focus] after", {
      activeAfter: (document.activeElement as HTMLElement | null)?.tagName,
      activeIsProxy: document.activeElement === inputProxyRef,
    });
  };

  onMount(() => {
    const el = containerRef;
    const gridHost = gridHostRef;
    const inputProxy = inputProxyRef;
    if (!el || !gridHost || !inputProxy) {
      // Solid onMount 契约保证 DOM 已挂载;到这里是 unreachable,fail loud。
      throw new Error("pane leaf refs missing on mount");
    }

    // 初始 rows/cols 先于 connect ── WS query 要带它。resize watcher 不在这里
    // 建,改由下方 zoom effect 持有(zoom 变了要重测 metrics 重建)。
    const metrics = measureCell(
      settings.fontFamily(),
      settings.effectiveFontSize(),
    );
    setCellMetrics(metrics);
    const { rows, cols } = cellsForBox(gridHost.getBoundingClientRect(), metrics);
    session.connect(rows, cols);
    setViewportH(el.clientHeight);

    let composing = false;
    let suppressNextInputText: string | null = null;
    let suppressResetTimer: number | undefined;
    const clearInputProxy = (): void => {
      inputProxy.value = "";
    };
    const suppressNextInputForComposition = (text: string): void => {
      suppressNextInputText = text;
      if (suppressResetTimer !== undefined) {
        window.clearTimeout(suppressResetTimer);
      }
      suppressResetTimer = window.setTimeout(() => {
        suppressNextInputText = null;
        suppressResetTimer = undefined;
      }, 0);
    };

    // 终端输入监听挂在**容器元素**上(不挂 document)。
    const onKeyDown = (e: KeyboardEvent): void => {
      // DIAGNOSTIC (IME 调试,定位后删):每个 keydown 打出来,看空格 / 拼音键
      // 时 isComposing / key / target / activeElement / textarea 视口位置长什么样。
      const proxyRect = inputProxy.getBoundingClientRect();
      console.log("[ime.keydown]", {
        key: e.key,
        code: e.code,
        keyCode: e.keyCode,
        isComposing: e.isComposing,
        composingFlag: composing,
        targetTag: (e.target as HTMLElement | null)?.tagName,
        activeTag: (document.activeElement as HTMLElement | null)?.tagName,
        activeIsProxy: document.activeElement === inputProxy,
        proxyRect: {
          top: Math.round(proxyRect.top),
          left: Math.round(proxyRect.left),
          width: Math.round(proxyRect.width),
          height: Math.round(proxyRect.height),
        },
        viewport: { w: window.innerWidth, h: window.innerHeight },
      });
      if (isPlainCopyShortcut(e)) {
        const hasTerminalSelection = selection() !== null;
        if (hasTerminalSelection) {
          e.preventDefault();
          copySelection();
          return;
        }
        // Cmd+C 是系统复制语义;无终端选区时也不要降级成字面 c。
        if (e.metaKey) {
          e.preventDefault();
          return;
        }
      }
      // 粘贴走浏览器默认路径触发 ClipboardEvent("paste"),由 onPaste 统一发后端。
      if (shouldBrowserHandlePasteShortcut(e)) return;
      const msg = encodeKeyboardEvent(e);
      if (!msg) return;
      e.preventDefault();
      session.send(msg);
    };
    const onPaste = (e: ClipboardEvent): void => {
      const text = e.clipboardData?.getData("text") ?? "";
      if (!text) return;
      e.preventDefault();
      session.send({ type: "paste", text });
    };
    let hasDomFocus = false;
    const onFocusIn = (e: FocusEvent): void => {
      console.log("[ime.focusin]", {
        targetTag: (e.target as HTMLElement | null)?.tagName,
        targetIsProxy: e.target === inputProxy,
        relatedTag: (e.relatedTarget as HTMLElement | null)?.tagName,
      });
      if (hasDomFocus) {
        props.onFocusRequest();
        return;
      }
      hasDomFocus = true;
      session.send({ type: "focus", gained: true });
      props.onFocusRequest();
    };
    const onFocusOut = (e: FocusEvent): void => {
      console.log("[ime.focusout]", {
        targetTag: (e.target as HTMLElement | null)?.tagName,
        targetIsProxy: e.target === inputProxy,
        relatedTag: (e.relatedTarget as HTMLElement | null)?.tagName,
        relatedInPane: e.relatedTarget instanceof Node && el.contains(e.relatedTarget),
      });
      const next = e.relatedTarget;
      if (next instanceof Node && el.contains(next)) return;
      hasDomFocus = false;
      session.send({ type: "focus", gained: false });
    };
    const onCompositionStart = (e: CompositionEvent): void => {
      console.log("[ime.compositionstart]", {
        targetTag: (e.target as HTMLElement | null)?.tagName,
        targetIsProxy: e.target === inputProxy,
        data: e.data,
      });
      if (e.target !== inputProxy) return;
      composing = true;
    };
    const onCompositionEnd = (e: CompositionEvent): void => {
      console.log("[ime.compositionend]", {
        targetTag: (e.target as HTMLElement | null)?.tagName,
        targetIsProxy: e.target === inputProxy,
        data: e.data,
        proxyValue: inputProxy.value,
      });
      if (e.target !== inputProxy) return;
      composing = false;
      const msg = compositionCommitMessage(e.data, inputProxy.value);
      clearInputProxy();
      if (!msg) {
        console.log("[ime.compositionend] dropped: empty commit");
        return;
      }
      console.log("[ime.compositionend] sending paste", msg);
      session.send(msg);
      suppressNextInputForComposition(msg.text);
    };
    const onInput = (e: Event): void => {
      const inputEv = e instanceof InputEvent ? e : null;
      console.log("[ime.input]", {
        targetTag: (e.target as HTMLElement | null)?.tagName,
        targetIsProxy: e.target === inputProxy,
        data: inputEv?.data,
        inputType: inputEv?.inputType,
        proxyValue: inputProxy.value,
        composingFlag: composing,
      });
      if (e.target !== inputProxy) return;
      if (composing) return;
      const msg = inputCommitMessage(
        e instanceof InputEvent ? e.data : null,
        inputProxy.value,
      );
      const text = msg?.text ?? "";
      if (text.length === 0) return;
      if (suppressNextInputText === text) {
        suppressNextInputText = null;
        clearInputProxy();
        return;
      }
      clearInputProxy();
      if (msg) session.send(msg);
    };
    let selectingPointer: number | null = null;
    let selectionAnchor: SelectionPoint | null = null;
    // TUI mouse reporting 的活跃指针。和 selectingPointer 互斥 ── 一次
    // pointer down 要么发起前端选择,要么转给 TUI。release 时需要原 button
    // 才能正确编码 SGR release。
    let tuiPointer: number | null = null;
    let tuiPointerButton: MouseButton | null = null;
    // 最近一次成功转换的 cell。drag / release 用钳制模式后理论上总能算出
    // cell;万一 metrics 失效拿不到,回退用上一次值,避免 release 丢失。
    let tuiLastCell: { row: number; col: number } | null = null;
    let wheelAccumPx = 0;

    const mouseMode = (): typeof session.store.state.modes.mouse_reporting =>
      session.store.state.modes.mouse_reporting;

    const onPointerDown = (e: PointerEvent): void => {
      props.onFocusRequest();
      focusInputProxy();
      const button = pointerButton(e.button);
      if (button === null) return;
      const point = pointForEvent(e);
      if (!point) return;

      const routing = decideMouseRouting({
        mouseReporting: mouseMode(),
        kind: "click",
        shiftKey: e.shiftKey,
      });

      if (routing === "tui") {
        const cell = cellForPoint(point);
        if (cell && sendMouseCell(e, cell, { type: "press", button })) {
          e.preventDefault();
          tuiPointer = e.pointerId;
          tuiPointerButton = button;
          tuiLastCell = cell;
          // setPointerCapture 保证后续 pointermove / pointerup 都派发到
          // 本元素 ── 即便鼠标拖出 viewport / 跨窗口释放,release 也不会
          // 漏发,TUI 不会卡在「键一直按着」。
          el.setPointerCapture(e.pointerId);
          return;
        }
        // 点击落在历史区:无 active grid cell,不上报、也不抢路径。让用户
        // 仍可在历史里用 selection 复制。继续走 selection 分支。
      }

      // selection 路径只接受 primary button ── middle/right 不启动选择。
      if (e.button !== 0) return;
      e.preventDefault();
      clearBrowserSelection();
      // Shift+click 扩选:沿用现有 selection 的 anchor,head 移到新点击位置。
      // 既有选择不存在时退化为普通新选择。
      const existing = e.shiftKey ? selection() : null;
      const anchor = existing ? existing.anchor : point;
      selectingPointer = e.pointerId;
      selectionAnchor = anchor;
      setSelection({ anchor, head: point });
      el.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent): void => {
      // TUI drag:有 active TUI pointer,按 drag 报。clamp 模式 ── 拖出
      // viewport 时把 cell 钳制到 active grid 边界,而不是丢事件。
      if (tuiPointer === e.pointerId && tuiPointerButton !== null) {
        const routing = decideMouseRouting({
          mouseReporting: mouseMode(),
          kind: "drag",
          shiftKey: e.shiftKey,
        });
        if (routing !== "tui") return;
        const point = pointForEvent(e);
        if (!point) return;
        const cell = cellForPoint(point, true);
        if (!cell) return;
        tuiLastCell = cell;
        if (sendMouseCell(e, cell, { type: "drag", button: tuiPointerButton })) {
          e.preventDefault();
        }
        return;
      }

      // 既有前端选择拖拽:已在 selection 路径里,不被 mouse mode 影响。
      if (selectingPointer === e.pointerId && selectionAnchor) {
        const head = pointForEvent(e, selectionAnchor);
        if (!head) return;
        e.preventDefault();
        clearBrowserSelection();
        setSelection({ anchor: selectionAnchor, head });
        return;
      }

      // 无按键 hover ── 仅 mouse_reporting === "any" 才上报 motion。
      if (e.buttons === 0) {
        const routing = decideMouseRouting({
          mouseReporting: mouseMode(),
          kind: "motion",
          shiftKey: e.shiftKey,
        });
        if (routing !== "tui") return;
        const point = pointForEvent(e);
        if (!point) return;
        sendMouseAt(e, point, { type: "motion" });
      }
    };

    const finishPointerSelection = (e: PointerEvent): void => {
      if (tuiPointer === e.pointerId) {
        const button = tuiPointerButton;
        const lastCell = tuiLastCell;
        tuiPointer = null;
        tuiPointerButton = null;
        tuiLastCell = null;
        if (el.hasPointerCapture(e.pointerId)) {
          el.releasePointerCapture(e.pointerId);
        }
        if (button === null) return;
        // release 必须发出去,否则 TUI 卡在「键一直按着」状态。优先用当前
        // pointer 钳制后的 cell,拿不到再回退用 last valid cell。
        const point = pointForEvent(e);
        const cell =
          (point ? cellForPoint(point, true) : null) ?? lastCell;
        if (!cell) return;
        if (sendMouseCell(e, cell, { type: "release", button })) {
          e.preventDefault();
        }
        return;
      }
      if (selectingPointer !== e.pointerId) return;
      e.preventDefault();
      clearBrowserSelection();
      selectingPointer = null;
      selectionAnchor = null;
      if (el.hasPointerCapture(e.pointerId)) {
        el.releasePointerCapture(e.pointerId);
      }
      const current = selection();
      if (!current || isCollapsedSelection(current)) setSelection(null);
    };

    const onWheel = (e: WheelEvent): void => {
      const routing = decideMouseRouting({
        mouseReporting: mouseMode(),
        kind: "click",
        shiftKey: e.shiftKey,
      });
      // selection 路径 = 让浏览器走 scrollback,不 preventDefault。
      if (routing !== "tui") return;
      const metrics = cellMetrics();
      if (!metrics) return;
      const point = pointForEvent(e);
      if (!point) return;
      const cell = cellForPoint(point);
      if (!cell) return;

      const { steps, remainder } = wheelLineSteps({
        accumulator: wheelAccumPx,
        deltaY: e.deltaY,
        deltaMode: e.deltaMode,
        cellHeight: metrics.cellH,
      });
      wheelAccumPx = remainder;
      if (steps === 0) {
        // 像素增量累积中,先抑制原生滚动 ── 否则用户感知到 scrollback 抖一下
        // 但 TUI 没反应。
        e.preventDefault();
        return;
      }
      e.preventDefault();
      const kindType: "wheel_down" | "wheel_up" =
        steps > 0 ? "wheel_down" : "wheel_up";
      const mods = collectMouseMods(e);
      const msg = buildMouseMessage({
        kind: { type: kindType },
        col: cell.col,
        row: cell.row,
        mods,
      });
      if (!msg) return;
      const count = Math.min(Math.abs(steps), 10);
      for (let i = 0; i < count; i++) session.send(msg);
    };
    // 抑制浏览器 / WebView 在 mouse reporting 开启时弹 context menu /
    // 触发中键自动滚动等默认行为 ── 否则右键和中键的 TUI 交互(tmux 弹
    // pane menu / vim visual mode 等)会被浏览器抢走。Shift 按下时让用户
    // 显式拿回浏览器默认。
    const suppressBrowserDefaultForTui = (e: MouseEvent): void => {
      if (mouseMode() === "off") return;
      if (e.shiftKey) return;
      e.preventDefault();
    };
    const onContextMenu = (e: MouseEvent): void => suppressBrowserDefaultForTui(e);
    const onAuxClick = (e: MouseEvent): void => suppressBrowserDefaultForTui(e);

    let scrollSyncRaf: number | undefined;
    const onScroll = (): void => {
      // 离底 < 4px 视作「贴底」── 贴底才自动滚,用户上滚后暂停。
      stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
      // scrollTop 信号驱动虚拟历史窗口;RAF 合批,一帧最多更新一次。
      if (scrollSyncRaf === undefined) {
        scrollSyncRaf = requestAnimationFrame(() => {
          scrollSyncRaf = undefined;
          setScrollTop(el.scrollTop);
        });
      }
    };

    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("paste", onPaste);
    el.addEventListener("focusin", onFocusIn);
    el.addEventListener("focusout", onFocusOut);
    el.addEventListener("compositionstart", onCompositionStart);
    el.addEventListener("compositionend", onCompositionEnd);
    el.addEventListener("input", onInput);
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", finishPointerSelection);
    el.addEventListener("pointercancel", finishPointerSelection);
    // wheel 必须 non-passive 才能 preventDefault 抢回 TUI 滚动。
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("contextmenu", onContextMenu);
    el.addEventListener("auxclick", onAuxClick);
    el.addEventListener("scroll", onScroll);

    onCleanup(() => {
      if (scrollRaf !== undefined) cancelAnimationFrame(scrollRaf);
      if (scrollSyncRaf !== undefined) cancelAnimationFrame(scrollSyncRaf);
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("paste", onPaste);
      el.removeEventListener("focusin", onFocusIn);
      el.removeEventListener("focusout", onFocusOut);
      el.removeEventListener("compositionstart", onCompositionStart);
      el.removeEventListener("compositionend", onCompositionEnd);
      el.removeEventListener("input", onInput);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", finishPointerSelection);
      el.removeEventListener("pointercancel", finishPointerSelection);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("contextmenu", onContextMenu);
      el.removeEventListener("auxclick", onAuxClick);
      el.removeEventListener("scroll", onScroll);
      if (suppressResetTimer !== undefined) {
        window.clearTimeout(suppressResetTimer);
      }
      // 卸载时仍持有焦点就显式补发 focus lost,否则后台 PTY 一直以为自己 focused。
      if (hasDomFocus) session.send({ type: "focus", gained: false });
      // 不关 socket ── workspace 拥有 session 的 disposal。
    });
  });

  // zoom 变化:重测 metrics、重建 resize watcher,并主动补发一帧 resize ──
  // zoom 改了 cell 尺寸但容器尺寸不变,ResizeObserver 不会自己 fire。
  // 首次运行不补发:onMount 的 connect 已带初始尺寸。
  let firstSizeEffect = true;
  createEffect(() => {
    const metrics = measureCell(
      settings.fontFamily(),
      settings.effectiveFontSize(),
    );
    setCellMetrics(metrics);
    const gridHost = gridHostRef;
    if (!gridHost) return;
    const watcher = observeContainerResize(gridHost, metrics, (r, c) => {
      session.send({ type: "resize", rows: r, cols: c });
      if (containerRef) {
        setViewportH(containerRef.clientHeight);
        if (stickToBottom) scrollToBottom();
      }
    });
    if (!firstSizeEffect) {
      const next = watcher.measure();
      session.send({ type: "resize", rows: next.rows, cols: next.cols });
    }
    firstSizeEffect = false;
    onCleanup(() => watcher.dispose());
  });

  // focused 变 true 而容器还没拿到 DOM 焦点时,把焦点抢过来。
  createEffect(() => {
    if (
      props.focused &&
      containerRef &&
      document.activeElement !== inputProxyRef
    ) {
      focusInputProxy();
    }
  });

  let lastSelectionShape = "";
  createEffect(() => {
    const shape = [
      session.store.state.historyLen,
      session.store.state.size.rows,
      session.store.state.size.cols,
      session.store.state.modes.alt_screen,
    ].join(":");
    if (lastSelectionShape !== "" && lastSelectionShape !== shape) {
      setSelection(null);
    }
    lastSelectionShape = shape;
  });

  // 内容增高(新输出 / 历史增长)时贴底滚动。读 seq / historyLen 让本 effect
  // 每帧跑一次,scrollToBottom 内部用 RAF 去重。
  createEffect(() => {
    void session.store.state.seq;
    void session.store.state.historyLen;
    if (stickToBottom) scrollToBottom();
  });

  return (
    <div
      ref={containerRef}
      tabindex={0}
      // focused 状态走 class 名:GridDom 内的 .pg-cursor-blink 通过后代选择器
      // 决定要不要跑闪烁动画;这样 GridDom 不需要 props.focused 注入。
      classList={{ "pg-pane-focused": props.focused }}
      style={containerStyle(props.focused)}
    >
      {/* tabindex=0(默认):WebKitGTK 的 IM 模块对 tabindex=-1 的 editable
          元素不激活 commit 通道(只让 fcitx5 弹候选,但 commit-string 不回传)。
          textarea 必须在正常 tab 流里才被认作 active IME target。 */}
      <textarea
        ref={inputProxyRef}
        aria-label="Terminal input"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        spellcheck={false}
        rows={1}
        style={inputProxyStyle()}
      />
      {/* 会话开始前就失败了(SSH connect / auth / profile 不存在)── 显示错误
          banner,grid / 历史照常但都是空的,用户能清晰看到原因。 */}
      <Show when={session.store.state.sessionError}>
        <SessionErrorBanner reason={session.store.state.sessionError!} />
      </Show>
      {/* 历史在上、活动区 DOM grid 在下。alt-screen(vim/tmux)时挂起历史,
          grid 独占。 */}
      <Show when={!session.store.state.modes.alt_screen}>
        <HistoryView
          history={session.store.history}
          historyLen={session.store.state.historyLen}
          failureGen={session.store.state.failureGen}
          scrollTop={scrollTop()}
          viewportHeight={viewportH()}
        />
      </Show>
      <div
        ref={gridHostRef}
        style={gridHostStyle(session.store.state.modes.alt_screen)}
      >
        <GridDom
          state={session.store.state}
          grid={session.store.grid}
          onRenderScheduled={() => session.reportRenderScheduled()}
          onRenderFrame={(ms) => session.reportRenderFrame(ms)}
          onRenderCancelled={() => session.reportRenderCancelled()}
        />
      </div>
      <SelectionOverlay rects={overlayRects()} />
    </div>
  );
};

const SelectionOverlay: Component<{ rects: ReturnType<typeof selectionRects> }> = (
  props,
) => (
  <div style={selectionOverlayStyle}>
    <For each={props.rects}>
      {(rect) => <div style={selectionRectStyle(rect)} />}
    </For>
  </div>
);

/// SSH 连接 / 认证失败的内嵌横幅。pane 顶部贴一条,可读地展示后端发来的
/// 错误原因 —— 否则用户只看到一个空白 grid + 关闭的 WS。
const SessionErrorBanner: Component<{ reason: string }> = (props) => (
  <div style={bannerStyle}>
    <div style={bannerTitleStyle}>会话未能建立</div>
    <div style={bannerBodyStyle}>{props.reason}</div>
  </div>
);

const bannerStyle: Record<string, string> = {
  padding: "10px 14px",
  background: "rgba(255,107,107,0.08)",
  "border-bottom": "1px solid #ff6b6b",
  color: "#ff6b6b",
  "font-family": "ui-monospace, monospace",
  "font-size": "12px",
};

const bannerTitleStyle: Record<string, string> = {
  "font-weight": "bold",
  "margin-bottom": "4px",
};

const bannerBodyStyle: Record<string, string> = {
  "white-space": "pre-wrap",
  "word-break": "break-word",
};

const selectionOverlayStyle: Record<string, string> = {
  position: "absolute",
  // 与 container 的 padding 对齐 ── 选区矩形坐标系起点和块流子节点的
  // 渲染原点一致(content area 起点),overlay 区域同样从 padding 内边开始。
  left: `${PANE_PADDING_PX}px`,
  top: `${PANE_PADDING_PX}px`,
  right: `${PANE_PADDING_PX}px`,
  bottom: `${PANE_PADDING_PX}px`,
  "pointer-events": "none",
  "z-index": "2",
};

function selectionRectStyle(
  rect: ReturnType<typeof selectionRects>[number],
): Record<string, string> {
  return {
    position: "absolute",
    top: `${rect.top}px`,
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    background: "var(--pg-selection-bg)",
  };
}

/// Hidden textarea used as the real browser text input target.
///
/// 视觉不可见靠 transparent color / bg / caret,**不**靠 opacity:0 或
/// pointer-events:none ── WebKitGTK 2.42+ 对 opacity<≈0.1 或
/// pointer-events:none 的 editable element 不激活 IM commit 通道
/// (fcitx5 候选框仍会显示,但 commit-string 不回传)。透明色 + 正常
/// opacity + auto pointer events 是让 WebKit / fcitx5 IM 链路完整工作的
/// 最小条件。
function hiddenInputProxyStyle(
  left: number,
  top: number,
  width: number,
  height: number,
  fontFamily: string = "monospace",
  fontSize: number = 14,
): Record<string, string> {
  return {
    position: "absolute",
    left: `${left}px`,
    top: `${top}px`,
    width: `${Math.max(1, width)}px`,
    height: `${Math.max(1, height)}px`,
    padding: "0",
    border: "0",
    margin: "0",
    outline: "none",
    resize: "none",
    overflow: "hidden",
    background: "transparent",
    color: "transparent",
    "caret-color": "transparent",
    "font-family": fontFamily,
    "font-size": `${fontSize}px`,
    "line-height": `${height}px`,
    "white-space": "pre",
    "z-index": "3",
  };
}

/// 活动区 grid 宿主。非 alt-screen 时左移一个 gutter 宽,使活动区文本列与
/// 历史文本列对齐(历史行左侧那条 gutter 是失败标记位)。
function gridHostStyle(altScreen: boolean): Record<string, string> {
  return {
    "margin-left": altScreen ? "0" : `${HISTORY_GUTTER_PX}px`,
    "min-width": "0",
    height: "100%",
    overflow: "hidden",
  };
}

/// 容器样式。非焦点 pane 降不透明度 ── 多 pane 时的焦点视觉指示;单 pane
/// 永远 focused,opacity 恒 1,自然无变暗。
function containerStyle(focused: boolean): Record<string, string> {
  return {
    position: "relative",
    width: "100%",
    height: "100%",
    "overflow-y": "auto",
    "overflow-x": "hidden",
    background: "var(--term-background)",
    outline: "none",
    "user-select": "none",
    "-webkit-user-select": "none",
    padding: `${PANE_PADDING_PX}px`,
    "box-sizing": "border-box",
    opacity: focused ? "1" : "0.6",
    transition: "opacity 0.12s ease",
  };
}
