// 右上角实时性能指标小角块。`?perf=1` 才显示。
//
// 视觉刻意简陋:固定单元素 div,文本内容由 setInterval 拉取。
// 它不参与 Solid 的细粒度反应式跟踪(避免给本就要测的 effect 加监听噪声),
// 而是用本地 createSignal + 1s tick 单向更新。

import { Component, createSignal, onCleanup, onMount } from "solid-js";

import type { PerfStats, PerfTracker } from "../util/perf";

const EMPTY: PerfStats = {
  mps: 0,
  parse_p50: 0,
  parse_p99: 0,
  dispatch_p50: 0,
  dispatch_p99: 0,
  render_p50: 0,
  render_p99: 0,
  bytes_p99: 0,
  n: 0,
  render_n: 0,
};

export const PerfOverlay: Component<{ tracker: PerfTracker }> = (props) => {
  const [stats, setStats] = createSignal<PerfStats>(EMPTY);

  onMount(() => {
    const id = window.setInterval(() => {
      setStats(props.tracker.drain());
    }, 1000);
    onCleanup(() => window.clearInterval(id));
  });

  return (
    <div style={style}>
      <div>
        <b>msg/s</b> {stats().mps.toFixed(0)}
        <span style={dim}> ({stats().n} in last 1s)</span>
      </div>
      <div>
        <b>parse</b> p50 {fmt(stats().parse_p50)} / p99 {fmt(stats().parse_p99)} ms
      </div>
      <div>
        <b>dispatch</b> p50 {fmt(stats().dispatch_p50)} / p99 {fmt(stats().dispatch_p99)} ms
      </div>
      <div>
        <b>render</b> p50 {fmt(stats().render_p50)} / p99 {fmt(stats().render_p99)} ms
        <span style={dim}> ({stats().render_n} frames)</span>
      </div>
      <div>
        <b>bytes</b> p99 {stats().bytes_p99.toLocaleString()} B/msg
      </div>
    </div>
  );
};

function fmt(ms: number): string {
  if (ms < 1) return ms.toFixed(2);
  if (ms < 100) return ms.toFixed(1);
  return ms.toFixed(0);
}

const style: Record<string, string> = {
  position: "fixed",
  top: "6px",
  right: "6px",
  "font-family": "ui-monospace, monospace",
  "font-size": "11px",
  "line-height": "1.4",
  color: "#9cdcfe",
  background: "rgba(0, 0, 0, 0.65)",
  padding: "6px 8px",
  "border-radius": "4px",
  "pointer-events": "none",
  "z-index": "9999",
  "white-space": "nowrap",
};

const dim: Record<string, string> = {
  color: "#777",
  "margin-left": "4px",
};
