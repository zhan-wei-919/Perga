// 容器尺寸 → 终端 cell 网格(rows / cols)+ debounce 上报。
//
// 流程:
//   ResizeObserver(container)
//     → 算 rows/cols(用 metrics.cellW / cellH)
//     → trailing debounce 80ms
//     → onResize(rows, cols)
//
// 重要约束:**最终尺寸一定送达**。debounce 用 trailing edge,不用 leading。
// 这样拖窗口结束的最后一帧 size 一定上报,server 端 grid / PTY winsize 都对齐。

import type { CellMetrics } from "../render/metrics";

export type ResizeObserverHandle = {
  /** 拆除监听 + 清理 pending timer。 */
  dispose: () => void;
  /** 同步计算当前容器对应的 cell 网格(用于 WS 首次 connect 前)。 */
  measure: () => { rows: number; cols: number };
};

export function observeContainerResize(
  el: HTMLElement,
  metrics: CellMetrics,
  onResize: (rows: number, cols: number) => void,
  delayMs = 80,
): ResizeObserverHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSent: { rows: number; cols: number } | null = null;

  const compute = (): { rows: number; cols: number } => {
    const rect = el.getBoundingClientRect();
    // floor:cells 必须填得下,半 cell 不画。最小 1 是给 alacritty / PTY
    // 一个合法值 ── 0 行 0 列会让 alacritty 算子里 div by zero。
    const rows = Math.max(1, Math.floor(rect.height / metrics.cellH));
    const cols = Math.max(1, Math.floor(rect.width / metrics.cellW));
    return { rows, cols };
  };

  const ro = new ResizeObserver(() => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
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
    }, delayMs);
  });
  ro.observe(el);

  return {
    dispose: () => {
      ro.disconnect();
      if (timer !== null) clearTimeout(timer);
    },
    measure: compute,
  };
}
