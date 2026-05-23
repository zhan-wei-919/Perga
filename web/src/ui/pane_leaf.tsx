// 一个终端 pane:把一个 `LeafSession` 装配成可见、可输入的终端。
//
// 布局:一个 `overflow-y:auto` 滚动容器,里面是 `[虚拟 DOM 历史][活动区 DOM grid]`。
// 历史(scrollback)和活动区都走 DOM 文本渲染,但活动区仍保持终端 cell grid 语义。
//
// session 资源(socket / store)由 workspace 拥有,本组件只消费 —— 组件 unmount
// **不**关 socket(split 重建树时 Solid 可能 remount 本组件,session 必须存活)。

import {
  Component,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";

import { shouldBrowserHandleCopyShortcut } from "../input/copy_shortcuts";
import { encodeKeyboardEvent } from "../input/keyboard";
import { shouldBrowserHandlePasteShortcut } from "../input/paste_shortcuts";
import { observeContainerResize } from "../input/resize";
import { GridDom } from "../render/grid_dom";
import { HISTORY_GUTTER_PX, HistoryView } from "../render/history_view";
import { cellsForBox, FONT_FAMILY, measureCell } from "../render/metrics";
import { useSettings } from "../state/settings_context";
import type { LeafSession } from "../state/workspace";

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

  // 虚拟历史列表要据滚动位置 / 视口高算可见窗口。
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportH, setViewportH] = createSignal(0);

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

  onMount(() => {
    const el = containerRef;
    const gridHost = gridHostRef;
    if (!el || !gridHost) {
      // Solid onMount 契约保证 DOM 已挂载;到这里是 unreachable,fail loud。
      throw new Error("pane leaf refs missing on mount");
    }

    // 初始 rows/cols 先于 connect ── WS query 要带它。resize watcher 不在这里
    // 建,改由下方 zoom effect 持有(zoom 变了要重测 metrics 重建)。
    const metrics = measureCell(FONT_FAMILY, settings.effectiveFontSize());
    const { rows, cols } = cellsForBox(gridHost.getBoundingClientRect(), metrics);
    session.connect(rows, cols);
    setViewportH(el.clientHeight);

    // 终端输入监听挂在**容器元素**上(不挂 document)。
    const onKeyDown = (e: KeyboardEvent): void => {
      // 有文本选区时 Ctrl/Cmd+C 让浏览器复制,不编码成 SIGINT。
      if (shouldBrowserHandleCopyShortcut(e, el)) return;
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
    const onFocus = (): void => {
      hasDomFocus = true;
      session.send({ type: "focus", gained: true });
      props.onFocusRequest();
    };
    const onBlur = (): void => {
      hasDomFocus = false;
      session.send({ type: "focus", gained: false });
    };
    const onPointerDown = (): void => {
      props.onFocusRequest();
      el.focus();
    };
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
    el.addEventListener("focus", onFocus);
    el.addEventListener("blur", onBlur);
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("scroll", onScroll);

    onCleanup(() => {
      if (scrollRaf !== undefined) cancelAnimationFrame(scrollRaf);
      if (scrollSyncRaf !== undefined) cancelAnimationFrame(scrollSyncRaf);
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("paste", onPaste);
      el.removeEventListener("focus", onFocus);
      el.removeEventListener("blur", onBlur);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("scroll", onScroll);
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
    const metrics = measureCell(FONT_FAMILY, settings.effectiveFontSize());
    const gridHost = gridHostRef;
    if (!gridHost) return;
    const watcher = observeContainerResize(gridHost, metrics, (r, c) => {
      session.send({ type: "resize", rows: r, cols: c });
      if (containerRef) setViewportH(containerRef.clientHeight);
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
      document.activeElement !== containerRef
    ) {
      containerRef.focus();
    }
  });

  // 内容增高(新输出 / 历史增长)时贴底滚动。读 seq / historyLen 让本 effect
  // 每帧跑一次,scrollToBottom 内部用 RAF 去重。
  createEffect(() => {
    void session.store.state.seq;
    void session.store.state.historyLen;
    if (stickToBottom) scrollToBottom();
  });

  return (
    <div ref={containerRef} tabindex={0} style={containerStyle(props.focused)}>
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
    </div>
  );
};

/// 活动区 grid 宿主。非 alt-screen 时左移一个 gutter 宽,使活动区文本列与
/// 历史文本列对齐(历史行左侧那条 gutter 是失败标记位)。
function gridHostStyle(altScreen: boolean): Record<string, string> {
  return {
    "margin-left": altScreen ? "0" : `${HISTORY_GUTTER_PX}px`,
    "min-width": "0",
    "min-height": "100%",
  };
}

/// 容器样式。非焦点 pane 降不透明度 ── 多 pane 时的焦点视觉指示;单 pane
/// 永远 focused,opacity 恒 1,自然无变暗。
function containerStyle(focused: boolean): Record<string, string> {
  return {
    width: "100%",
    height: "100%",
    "overflow-y": "auto",
    "overflow-x": "hidden",
    background: "var(--term-background)",
    outline: "none",
    opacity: focused ? "1" : "0.6",
    transition: "opacity 0.12s ease",
  };
}
