// 一个终端 pane:把一个 `LeafSession` 装配成可见、可输入的终端。
//
// 这是 Phase 1 `app.tsx` 里「整窗一个终端」那段装配的 per-pane 版本。session
// 资源(socket / store)由 workspace 拥有,本组件只消费 ── 所以组件 unmount
// **不**关 socket(split 重建树时 Solid 可能 remount 本组件,session 必须存活)。

import { Component, createEffect, onCleanup, onMount, Show } from "solid-js";

import { encodeKeyboardEvent } from "../input/keyboard";
import { observeContainerResize } from "../input/resize";
import { BlockList } from "../render/block_list";
import { GridCanvas } from "../render/grid_canvas";
import { cellsForBox, measureCell } from "../render/metrics";
import type { LeafSession } from "../state/workspace";

const FONT_FAMILY =
  'ui-monospace, "Cascadia Code", "JetBrains Mono", "Fira Code", Menlo, Consolas, monospace';
const FONT_SIZE = 14;

export type PaneLeafProps = {
  session: LeafSession;
  /** 是否是 active tab 的 focused leaf。 */
  focused: boolean;
  /** 点击 / 获得 DOM 焦点时请求 workspace 把焦点指到本 leaf。 */
  onFocusRequest: () => void;
};

/// 单个终端 pane。容器自身可聚焦(`tabindex=0`),终端输入监听挂在容器上。
export const PaneLeaf: Component<PaneLeafProps> = (props) => {
  // session 在本组件生命周期内恒定 ── 一个 PaneLeaf 始终对应同一个 leaf id。
  // 一次性捕获,绝不在 onMount / onCleanup / 事件回调里走 `props.session` 这个
  // 响应式 getter:它在 `PaneNode` 里是 `workspace.sessionFor(leaf().id)`,组件
  // 卸载时该 leaf 可能已被 dispose、或 `<Match>` 的 accessor 已失效,重算会抛错
  // 并打断 Solid 的同步更新,毁掉整个 app。
  const session = props.session;
  let containerRef: HTMLDivElement | undefined;

  // 自动滚到底:有新内容时把活动区 Canvas 滚进视野;用户手动上滚后暂停,
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
    if (!el) {
      // Solid onMount 契约保证 DOM 已挂载;到这里是 unreachable,fail loud。
      throw new Error("pane leaf container ref missing on mount");
    }

    const metrics = measureCell(FONT_FAMILY, FONT_SIZE);
    // 初始 rows/cols 先于 connect ── WS query 要带它。
    const { rows, cols } = cellsForBox(el.getBoundingClientRect(), metrics);
    session.connect(rows, cols);

    const sizeWatcher = observeContainerResize(el, metrics, (r, c) => {
      session.send({ type: "resize", rows: r, cols: c });
    });

    // 终端输入监听挂在**容器元素**上(不挂 document)。app 根的 capture 阶段
    // 拦截器已经吃掉了 workspace 快捷键,到这里的按键只会是终端输入。
    const onKeyDown = (e: KeyboardEvent): void => {
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
    // DOM 焦点的真值;onCleanup 据它判断卸载时是否要补发 focus lost。
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
    const onScroll = (): void => {
      // 离底 < 4px 视作「贴底」── 贴底才自动滚,用户上滚后暂停。
      stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
    };

    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("paste", onPaste);
    el.addEventListener("focus", onFocus);
    el.addEventListener("blur", onBlur);
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("scroll", onScroll);

    onCleanup(() => {
      sizeWatcher.dispose();
      if (scrollRaf !== undefined) cancelAnimationFrame(scrollRaf);
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("paste", onPaste);
      el.removeEventListener("focus", onFocus);
      el.removeEventListener("blur", onBlur);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("scroll", onScroll);
      // DOM 元素被移除时 blur 不一定触发(切 tab 卸载本 pane);卸载时仍持有
      // 焦点就显式补发 focus lost,否则后台 PTY 会一直以为自己是 focused。
      // session 已 dispose 时 send 会被 socket 层静默丢弃,安全。
      if (hasDomFocus) session.send({ type: "focus", gained: false });
      // 不关 socket ── workspace 拥有 session 的 disposal。
    });
  });

  // focused 变 true 而容器还没拿到 DOM 焦点时,把焦点抢过来 ── 让 Alt+Arrow /
  // 点击 既移动逻辑焦点,也把键盘事件路由到本 pane。
  createEffect(() => {
    if (
      props.focused &&
      containerRef &&
      document.activeElement !== containerRef
    ) {
      containerRef.focus();
    }
  });

  // 内容增高(新块 / 新输出 / 活动区下移)时贴底滚动。读 seq 让本 effect
  // 每帧都跑一次,scrollToBottom 内部用 RAF 去重。
  createEffect(() => {
    void session.store.state.seq;
    void session.store.state.blocks.length;
    void session.store.state.activeTop;
    if (stickToBottom) scrollToBottom();
  });

  return (
    <div ref={containerRef} tabindex={0} style={containerStyle}>
      {/* 命令块在上、活动区 Canvas 在下。alt-screen(vim/tmux)时挂起
          BlockList,后端也会把 active_top 强制 0 让 Canvas 占满。 */}
      <Show when={!session.store.state.modes.alt_screen}>
        <BlockList
          blocks={session.store.state.blocks}
          fontFamily={FONT_FAMILY}
          fontSize={FONT_SIZE}
          onToggleFold={(id) => session.store.toggleBlockFold(id)}
        />
      </Show>
      <GridCanvas
        state={session.store.state}
        grid={session.store.grid}
        fontSize={FONT_SIZE}
        onRenderScheduled={() => session.reportRenderScheduled()}
        onRenderFrame={(ms) => session.reportRenderFrame(ms)}
        onRenderCancelled={() => session.reportRenderCancelled()}
      />
    </div>
  );
};

const containerStyle: Record<string, string> = {
  width: "100%",
  height: "100%",
  // 命令块在上、活动区 Canvas 在下,内容超出 pane 时整体竖向滚动。
  "overflow-y": "auto",
  "overflow-x": "hidden",
  background: "#1e1e1e",
  // 不显示浏览器默认 focus outline ── 多 pane 的焦点视觉留待 settings 面板统一做。
  outline: "none",
};
