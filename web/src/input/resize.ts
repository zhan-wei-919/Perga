// 容器尺寸 → 终端 cell 网格(rows / cols)+ RAF 合批上报。
//
// 流程:
//   ResizeObserver(container)
//     → 算 rows/cols(用 metrics.cellW / cellH)
//     → 下一帧上报最新 rows/cols
//     → onResize(rows, cols)
//
// 传统终端 resize 是按 cell 取整后尽快跟随窗口,不能等拖动停下来再变。
// RAF 合批能保证一帧最多发一次,同时最终尺寸一定送达。

import { cellsForBox, type CellMetrics } from "../render/metrics";

export type ResizeObserverHandle = {
  /** 拆除监听 + 清理 pending frame。 */
  dispose: () => void;
  /** 同步计算当前容器对应的 cell 网格(用于 WS 首次 connect 前)。 */
  measure: () => { rows: number; cols: number };
};

export function observeContainerResize(
  el: HTMLElement,
  metrics: CellMetrics,
  onResize: (rows: number, cols: number) => void,
): ResizeObserverHandle {
  let rafId: number | null = null;
  // onMount 的 initial connect 已经用当前尺寸建了 session。这里把当前尺寸作为
  // baseline,避免 ResizeObserver.observe 后的初始通知重复发一次 resize。
  let lastSent: { rows: number; cols: number } | null = null;

  const compute = (): { rows: number; cols: number } =>
    cellsForBox(el.getBoundingClientRect(), metrics);

  lastSent = compute();

  const flush = (): void => {
    rafId = null;
    const next = compute();
    if (
      lastSent &&
      lastSent.rows === next.rows &&
      lastSent.cols === next.cols
    ) {
      // 同尺寸不重发 ── 字体没变 / 容器抖动等噪声 fire 会反复触发 ResizeObserver,
      // 防止给后端引擎 / PTY 发无意义的 winsize。
      return;
    }
    lastSent = next;
    onResize(next.rows, next.cols);
  };

  const ro = new ResizeObserver(() => {
    if (rafId !== null) return;
    rafId = window.requestAnimationFrame(flush);
  });
  ro.observe(el);

  return {
    dispose: () => {
      ro.disconnect();
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
    },
    measure: compute,
  };
}
