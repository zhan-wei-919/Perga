// 浏览器侧性能采样。
//
// 默认关闭(零开销)。URL 上挂 `?perf=1` 时启用,在右上角显示实时指标。
//
// 指标含义:
//   - msg/s         : 每秒收到多少个 WS ProtocolEvent。`ls` 这种短命令应 < 10/s。
//                     长输出(cat largefile)能轻松上 1000+。
//   - parse ms p99  : `JSON.parse(text)` 的耗时分布(每个 msg 单独测)。
//                     通常 <0.5ms;>5ms 说明 wire 太大或 GC 压力。
//   - dispatch ms p99: `store.dispatch(ev)` 即 reducer + Solid setStore。
//   - render ms p99  : RAF 中 canvas redraw 的 CPU 工作;可见 paint 还要等浏览器
//                     compositor frame(~16ms@60Hz)。
//   - bytes p99     : 单条 msg 的 JSON 长度,用于和 wire ratio 对照。

export type PerfStats = {
  mps: number;
  parse_p50: number;
  parse_p99: number;
  dispatch_p50: number;
  dispatch_p99: number;
  render_p50: number;
  render_p99: number;
  bytes_p99: number;
  n: number;
  render_n: number;
};

const EMPTY_STATS: PerfStats = {
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

export class PerfTracker {
  private enabled: boolean;
  private parseSamples: number[] = [];
  private dispatchSamples: number[] = [];
  private renderSamples: number[] = [];
  private byteSamples: number[] = [];
  private msgsThisWindow = 0;
  private lastTickAt: number;

  constructor(enabled: boolean) {
    this.enabled = enabled;
    this.lastTickAt = performance.now();
  }

  /// 记录一个 JSON.parse 耗时(ms)+ 原始 wire 字节数。
  recordParse(durationMs: number, bytes: number): void {
    if (!this.enabled) return;
    this.parseSamples.push(durationMs);
    this.byteSamples.push(bytes);
  }

  /// 记录一个 dispatch 调用耗时(ms)。RAF canvas 绘制另走 render 样本。
  recordDispatch(durationMs: number): void {
    if (!this.enabled) return;
    this.dispatchSamples.push(durationMs);
    this.msgsThisWindow++;
  }

  /// 记录一个 RAF render frame 耗时(ms)。
  recordRenderFrame(durationMs: number): void {
    if (!this.enabled) return;
    this.renderSamples.push(durationMs);
  }

  /// 由 overlay 组件每 1s 拉一次。返回这一秒的统计并重置窗口。
  drain(): PerfStats {
    if (!this.enabled) return EMPTY_STATS;
    const now = performance.now();
    const elapsedS = (now - this.lastTickAt) / 1000;
    if (elapsedS <= 0) return EMPTY_STATS;

    const out: PerfStats = {
      mps: this.msgsThisWindow / elapsedS,
      parse_p50: pct(this.parseSamples, 0.5),
      parse_p99: pct(this.parseSamples, 0.99),
      dispatch_p50: pct(this.dispatchSamples, 0.5),
      dispatch_p99: pct(this.dispatchSamples, 0.99),
      render_p50: pct(this.renderSamples, 0.5),
      render_p99: pct(this.renderSamples, 0.99),
      bytes_p99: pct(this.byteSamples, 0.99),
      n: this.dispatchSamples.length,
      render_n: this.renderSamples.length,
    };

    this.parseSamples.length = 0;
    this.dispatchSamples.length = 0;
    this.renderSamples.length = 0;
    this.byteSamples.length = 0;
    this.msgsThisWindow = 0;
    this.lastTickAt = now;
    return out;
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

function pct(arr: number[], q: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q));
  return sorted[i];
}

/// 读 `?perf=1`(或任意 truthy 值),判断是否启用。
export function shouldEnablePerf(): boolean {
  if (typeof window === "undefined") return false;
  const p = new URLSearchParams(window.location.search).get("perf");
  return p === "1" || p === "true";
}
