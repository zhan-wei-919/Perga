// 虚拟化的 DOM 历史列表 —— scrollback 在这里渲染成可选中复制的纯文本行。
//
// 历史可能上万行,只渲染当前可见窗口(屏高 + overscan):一个撑总高的 spacer
// + 窗口内绝对定位的行。失败命令的行左侧 gutter 染红。
//
// 行高必须与 Canvas 的 cellH 完全一致(同一 `fontSize*1.3` 公式),否则历史与
// 活动区行距错位、滚动跳变。

import { For, type Component, createMemo } from "solid-js";

import type { HistoryBuffer } from "../state/history";
import { computeWindow } from "../state/history";
import { useSettings } from "../state/settings_context";
import { FONT_FAMILY } from "./metrics";
import { segmentStyle, segmentsForRow } from "./row_segments";

/// 历史行左侧 gutter 宽度(失败标记占这条)。活动区 Canvas 左移同样的量对齐。
export const HISTORY_GUTTER_PX = 6;

const OVERSCAN = 8;

export type HistoryViewProps = {
  history: HistoryBuffer;
  /** history.rows.length 的响应式镜像 —— 撑 spacer 高、驱动窗口重算。 */
  historyLen: number;
  /** 失败标记 generation —— 变化时重算可见行的失败态。 */
  failureGen: number;
  /** 滚动容器的 scrollTop。 */
  scrollTop: number;
  /** 滚动容器的可见高度。 */
  viewportHeight: number;
};

export const HistoryView: Component<HistoryViewProps> = (props) => {
  const settings = useSettings();
  // 与 metrics.ts 的 cellH 同一公式 —— 保证历史 / 活动区行距一致。
  const lineHeight = (): number =>
    Math.round(settings.effectiveFontSize() * 1.3);

  const range = createMemo(() =>
    computeWindow(
      props.scrollTop,
      props.viewportHeight,
      lineHeight(),
      props.historyLen,
      OVERSCAN,
    ),
  );

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: `${props.historyLen * lineHeight()}px`,
        "flex-shrink": "0",
      }}
    >
      <For each={props.history.rows.slice(range().start, range().end)}>
        {(row, i) => {
          const failed = (): boolean => {
            // 读 failureGen 让本派生在失败标记落地时重算。
            void props.failureGen;
            return props.history.failed.has(row.abs);
          };
          return (
            <div
              style={lineStyle(
                (range().start + i()) * lineHeight(),
                lineHeight(),
              )}
            >
              <div style={gutterStyle(failed())} />
              <div
                style={textStyle(settings.effectiveFontSize(), lineHeight())}
              >
                <For each={segmentsForRow(row.cells)}>
                  {(seg) => <span style={segmentStyle(seg)}>{seg.text}</span>}
                </For>
              </div>
            </div>
          );
        }}
      </For>
    </div>
  );
};

function lineStyle(top: number, lineHeight: number): Record<string, string> {
  return {
    position: "absolute",
    top: `${top}px`,
    left: "0",
    right: "0",
    height: `${lineHeight}px`,
    display: "flex",
  };
}

function gutterStyle(failed: boolean): Record<string, string> {
  return {
    flex: `0 0 ${HISTORY_GUTTER_PX}px`,
    background: failed ? "var(--pg-exit-fail)" : "transparent",
  };
}

function textStyle(
  fontSize: number,
  lineHeight: number,
): Record<string, string> {
  return {
    flex: "1",
    "min-width": "0",
    "font-family": FONT_FAMILY,
    "font-size": `${fontSize}px`,
    "line-height": `${lineHeight}px`,
    "white-space": "pre",
    "user-select": "text",
  };
}
