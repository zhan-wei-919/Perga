// App 顶层组件:把 metrics / WS / store / Canvas / 输入流装配成一个全屏终端。
//
// Phase 1 形态:**整个浏览器窗口 = 一个 terminal**。tabs / panes 在 Phase 2
// 接进来,届时这里会变成 PaneTree 渲染器的 root。
//
// 生命周期:
//   onMount
//     measure cell → 算容器对应的初始 rows/cols
//     open WS                  (查询参数携带初始尺寸)
//     attach keyboard / paste / focus / resize observer
//   onCleanup
//     close WS,detach 所有事件

import { Component, Show, onCleanup, onMount } from "solid-js";

import { encodeKeyboardEvent } from "../input/keyboard";
import { observeContainerResize } from "../input/resize";
import { SessionSocket } from "../net/ws";
import { GridCanvas } from "../render/grid_canvas";
import { measureCell } from "../render/metrics";
import { createSessionStore } from "../state/session_store";
import { AutoBench } from "../util/autotest";
import { PerfTracker, shouldEnablePerf } from "../util/perf";
import { AutoTestButton } from "./autotest_button";
import { PerfOverlay } from "./perf_overlay";

const FONT_FAMILY =
  'ui-monospace, "Cascadia Code", "JetBrains Mono", "Fira Code", Menlo, Consolas, monospace';
const FONT_SIZE = 14;

// 默认尺寸:store 在 onMount 之前需要一个合法 size 才能 createStore。
// onMount 一进来立刻按容器算真实尺寸 + open WS,第一帧 Init 一到这个 24×80
// 就被替换。任何用户实际看到的内容都是 Init 之后的。
const FALLBACK_SIZE = { rows: 24, cols: 80 };

export const App: Component = () => {
  let containerRef: HTMLDivElement | undefined;
  const store = createSessionStore(FALLBACK_SIZE);
  const perfTracker = new PerfTracker(shouldEnablePerf());
  // 基准执行器在 body 创建,onMount 拿到 socket 后再 attach。
  const autoBench = new AutoBench();
  const onRenderFrame = (durationMs: number): void => {
    perfTracker.recordRenderFrame(durationMs);
    autoBench.onRenderFrame(durationMs);
  };

  onMount(() => {
    if (!containerRef) {
      // ref 没拿到 ── DOM 还没挂载完。Solid onMount 契约保证 DOM 已就位,
      // 这里相当于 unreachable;CLAUDE.md §不过度兜底,fail loud。
      throw new Error("container ref missing on mount");
    }

    const metrics = measureCell(FONT_FAMILY, FONT_SIZE);

    // 初始 rows/cols。先于 WS open,因为 query 参数要带它。
    const rect = containerRef.getBoundingClientRect();
    const rows = Math.max(1, Math.floor(rect.height / metrics.cellH));
    const cols = Math.max(1, Math.floor(rect.width / metrics.cellW));

    const socket = new SessionSocket({
      rows,
      cols,
      onEvent: (ev) => {
        if (!perfTracker.isEnabled()) {
          store.dispatch(ev);
          return;
        }
        const t0 = performance.now();
        store.dispatch(ev);
        // Canvas 绘制已进入 GridCanvas 的 RAF,这里仅测 reducer + setStore。
        const dispatchMs = performance.now() - t0;
        perfTracker.recordDispatch(dispatchMs);
        // 喂给基准的静默检测状态机;非 run 期间它只更新内部计数,无副作用。
        autoBench.onEvent(dispatchMs);
      },
      onClose: ({ code, reason }) => {
        // Phase 1 没 reconnect ── 上一帧屏幕保留,用户能看到关闭原因。
        // Phase 2+ 这里会触发对应 tab 的"已断开"指示。
        console.warn(`perga.ws.closed code=${code} reason=${reason}`);
      },
      onError: (msg) => console.warn(`perga.ws.error ${msg}`),
      perfTracker: perfTracker.isEnabled() ? perfTracker : undefined,
    });
    socket.connect();

    // 基准用 socket 发输入;session 退出后 abortCheck 让正在跑的 run 提前停。
    autoBench.attach((msg) => socket.send(msg), () => store.state.exited);

    const sizeWatcher = observeContainerResize(
      containerRef,
      metrics,
      (newRows, newCols) => {
        socket.send({ type: "resize", rows: newRows, cols: newCols });
      },
    );

    const onKeyDown = (e: KeyboardEvent): void => {
      // Ctrl/Cmd + Shift + I / J 等开发者工具组合给 Cmd 路径让步,
      // 不阻止默认行为(meta-key 在 encoder 已被丢弃,不会构造 msg)。
      const msg = encodeKeyboardEvent(e);
      if (!msg) return;
      e.preventDefault();
      socket.send(msg);
    };

    const onPaste = (e: ClipboardEvent): void => {
      const text = e.clipboardData?.getData("text") ?? "";
      if (!text) return;
      e.preventDefault();
      socket.send({ type: "paste", text });
    };

    const onWinFocus = (): void => socket.send({ type: "focus", gained: true });
    const onWinBlur = (): void => socket.send({ type: "focus", gained: false });

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("paste", onPaste);
    window.addEventListener("focus", onWinFocus);
    window.addEventListener("blur", onWinBlur);

    onCleanup(() => {
      sizeWatcher.dispose();
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("paste", onPaste);
      window.removeEventListener("focus", onWinFocus);
      window.removeEventListener("blur", onWinBlur);
      socket.close();
    });
  });

  return (
    <div
      ref={containerRef}
      style={{
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        background: "#1e1e1e",
        // 防止 canvas 因 inline-block 行为带来下方多余空白。
        "line-height": "0",
      }}
    >
      <GridCanvas
        state={store.state}
        grid={store.grid}
        fontSize={FONT_SIZE}
        onRenderScheduled={() => autoBench.onRenderScheduled()}
        onRenderFrame={onRenderFrame}
      />
      <Show when={perfTracker.isEnabled()}>
        <PerfOverlay tracker={perfTracker} />
        <AutoTestButton bench={autoBench} />
      </Show>
    </div>
  );
};
