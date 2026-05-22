// 自动化基准:连续执行 N 条 shell 命令,逐条测量「回车 → 命令结束」的往返耗时,
// 跑完把汇总打印到 console。
//
// 命令结束的判定:OSC 133 的 `command_end` 协议事件 —— 后端在一条命令跑完时
// 下发,autotest 收到即确定性判定该命令结束,不再靠静默窗口轮询。前提是用户
// source 了 shell 集成脚本;没 source 时收不到 `command_end`,命令阶段只能
// 退化到 MAX_COMMAND_MS 兜底超时。
//
// 输入回显阶段(把命令逐字符打进去)仍用静默窗口启发式 —— 回显没有协议级的
// 结束信号;但这段不计入耗时统计,只为把回显和命令输出两段事件流分开。
//
// 这是开发期工具,与 perf overlay 一样只在 `?perf=1` 下接入(见 app.tsx)。

import type { ClientMessage } from "../state/wire";

// 输入回显阶段:连续这么久没有新事件,视为回显已落定。
const QUIET_MS = 60;
// 单条命令的硬上限,防止某条卡死拖垮整个 run。等不到 command_end 时兜底。
const MAX_COMMAND_MS = 2000;
// 静默检测的轮询间隔。只影响「发现落定」的延迟,不影响记录的耗时数值
// (latency 用精确的事件时间戳算,与轮询粒度无关)。
const POLL_MS = 15;
// 输入回显阶段的硬上限。正常 shell 总会回显,这只是兜底。
const MAX_ECHO_MS = 800;

export type LatencyStats = {
  min: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  mean: number;
};

export type BenchResult = {
  command: string;
  iterations: number;
  completed: number;
  timeouts: number;
  totalMs: number;
  events: number;
  /// 「回车 → command_end 到达」往返耗时(ms)。
  latency: LatencyStats;
  /// 「回车 → 首个输出事件」耗时(ms)。
  firstEventP50: number;
  firstEventP99: number;
  /// dispatch(reducer + Solid setStore)整个 run 的汇总(ms)。
  dispatchP50: number;
  dispatchP99: number;
  dispatchMax: number;
  dispatchSamples: number;
  /// RAF canvas render frame 的汇总(ms)。
  renderFrameP50: number;
  renderFrameP99: number;
  renderFrameMax: number;
  renderFrameSamples: number;
};

export type ProgressFn = (done: number, total: number) => void;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/// 自动基准执行器。
///
/// 生命周期:`attach` 接上 socket → `run` 跑一轮 → 结果打印到 console 并返回。
/// `onEvent` 由 app 在每条协议事件后调用,喂给静默检测状态机。
export class AutoBench {
  private sender: ((msg: ClientMessage) => void) | null = null;
  private abortCheck: () => boolean = () => false;
  private running = false;

  // 当前测量窗口的事件统计。onEvent 写,waitSettle 读。
  private windowStart = 0;
  private firstEventAt = 0;
  private lastEventAt = 0;
  private eventsInWindow = 0;
  // 命令结束信号:onCommandEnd 置位,waitForCommandEnd 读。
  private commandEnded = false;
  private commandEndedAt = 0;

  // 整个 run 的累计。recording 为 true 时才累加。
  private dispatchSamples: number[] = [];
  private renderFrameSamples: number[] = [];
  private pendingRenderFrames = 0;
  private totalEvents = 0;
  private recording = false;

  /// 接上 socket。必须在 socket 建立后调用(见 app.tsx onMount)。
  attach(send: (msg: ClientMessage) => void, shouldAbort: () => boolean): void {
    this.sender = send;
    this.abortCheck = shouldAbort;
  }

  isRunning(): boolean {
    return this.running;
  }

  /// 每条协议事件 dispatch 完成后由 app 调用。
  /// `dispatchMs` 与 perf overlay 是同一份 store 更新测量(reducer + setStore)。
  onEvent(dispatchMs: number): void {
    const now = performance.now();
    if (this.eventsInWindow === 0) this.firstEventAt = now;
    this.lastEventAt = now;
    this.eventsInWindow++;
    if (this.recording) {
      this.totalEvents++;
      this.dispatchSamples.push(dispatchMs);
    }
  }

  /// 收到一条 `command_end` 协议事件时由 app 调用 —— 命令执行结束的确定信号。
  onCommandEnd(): void {
    if (!this.commandEnded) {
      this.commandEnded = true;
      this.commandEndedAt = performance.now();
    }
  }

  /// 记录一个 RAF render 已排队,用于让静默窗口等到画面 flush 完。
  onRenderScheduled(): void {
    this.pendingRenderFrames++;
  }

  /// 记录一个 RAF render 完成。
  onRenderFrame(durationMs: number): void {
    if (this.pendingRenderFrames > 0) this.pendingRenderFrames--;
    if (this.recording) {
      this.renderFrameSamples.push(durationMs);
    }
  }

  /// 记录一个已排队的 RAF render 在 flush 前被取消(GridCanvas 卸载)。
  /// 与 onRenderScheduled 配对,避免 pending 计数泄漏导致 waitSettle 永久超时。
  onRenderCancelled(): void {
    if (this.pendingRenderFrames > 0) this.pendingRenderFrames--;
  }

  /// 跑一轮基准:连续执行 `iterations` 条 `command`。
  /// 已在运行或未 attach socket 时返回 null。
  async run(
    command: string,
    iterations: number,
    onProgress?: ProgressFn,
  ): Promise<BenchResult | null> {
    if (this.running || !this.sender) return null;
    this.running = true;
    this.recording = true;
    this.dispatchSamples = [];
    this.renderFrameSamples = [];
    this.totalEvents = 0;

    const latencies: number[] = [];
    const firstEvents: number[] = [];
    let completed = 0;
    let timeouts = 0;

    const runStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      // session 已退出(WS 关闭 / 子进程死)就停,跑下去没有意义。
      if (this.abortCheck()) break;

      // 阶段 1:逐字符输入命令,等回显落定。不计入耗时统计,只是为了把
      // 「输入回显」和「命令执行输出」两段事件流分开,后者才是要测的。
      this.beginWindow();
      for (const ch of command) {
        this.send({ type: "key", key: { type: "char", value: ch } });
      }
      await this.waitSettle(MAX_ECHO_MS, { allowNoEvent: true });
      if (this.abortCheck()) break;

      // 阶段 2:回车执行,等 command_end 确定性判定命令结束。
      this.beginWindow();
      const t0 = performance.now();
      this.send({ type: "key", key: { type: "enter" } });
      const settled = await this.waitForCommandEnd(MAX_COMMAND_MS);

      if (settled) {
        latencies.push(this.commandEndedAt - t0);
        firstEvents.push(this.firstEventAt - t0);
        completed++;
      } else {
        timeouts++;
      }
      onProgress?.(i + 1, iterations);
    }
    const totalMs = performance.now() - runStart;

    this.recording = false;
    this.running = false;

    const latency = summarize(latencies);
    const firstEvent = summarize(firstEvents);
    const dispatch = summarize(this.dispatchSamples);
    const render = summarize(this.renderFrameSamples);
    const result: BenchResult = {
      command,
      iterations,
      completed,
      timeouts,
      totalMs,
      events: this.totalEvents,
      latency,
      firstEventP50: firstEvent.p50,
      firstEventP99: firstEvent.p99,
      dispatchP50: dispatch.p50,
      dispatchP99: dispatch.p99,
      dispatchMax: dispatch.max,
      dispatchSamples: this.dispatchSamples.length,
      renderFrameP50: render.p50,
      renderFrameP99: render.p99,
      renderFrameMax: render.max,
      renderFrameSamples: this.renderFrameSamples.length,
    };
    logResult(result);
    return result;
  }

  /// 开一个新的测量窗口:清空事件计数,记下窗口起点。
  private beginWindow(): void {
    this.windowStart = performance.now();
    this.firstEventAt = 0;
    this.lastEventAt = 0;
    this.eventsInWindow = 0;
    this.commandEnded = false;
    this.commandEndedAt = 0;
  }

  /// 轮询等待 `command_end` 到达(命令执行结束的确定信号)。
  /// 返回 true = 收到;false = 到 `maxMs` 仍没收到(交互态命令 / 没 source 脚本)。
  private async waitForCommandEnd(maxMs: number): Promise<boolean> {
    for (;;) {
      await sleep(POLL_MS);
      if (this.commandEnded) return true;
      if (performance.now() - this.windowStart >= maxMs) return false;
    }
  }

  /// 轮询等待当前窗口的事件流静默。
  /// 返回 true = 正常落定;false = 到 `maxMs` 仍未静默(命令超时)。
  private async waitSettle(
    maxMs: number,
    options: { allowNoEvent?: boolean } = {},
  ): Promise<boolean> {
    for (;;) {
      await sleep(POLL_MS);
      const now = performance.now();
      const sawEvent = this.eventsInWindow > 0;
      const quietSince = sawEvent ? this.lastEventAt : this.windowStart;
      if (
        (sawEvent || options.allowNoEvent === true) &&
        now - quietSince >= QUIET_MS &&
        this.pendingRenderFrames === 0
      ) {
        return true;
      }
      if (now - this.windowStart >= maxMs) {
        return false;
      }
    }
  }

  private send(msg: ClientMessage): void {
    // run() 已确认 sender 非 null;这里只是给类型收窄。
    if (!this.sender) throw new Error("autobench: socket not attached");
    this.sender(msg);
  }
}

/// 把一组耗时样本汇总成 min/p50/p90/p99/max/mean。空样本返回全 0。
export function summarize(samples: number[]): LatencyStats {
  if (samples.length === 0) {
    return { min: 0, p50: 0, p90: 0, p99: 0, max: 0, mean: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    min: sorted[0],
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
  };
}

/// 从**已排序**数组取分位数。与 util/perf.ts 的 pct 同一约定。
export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q));
  return sorted[i];
}

/// 把一轮基准结果打印到 console。
function logResult(r: BenchResult): void {
  console.group(
    `%c[perga autotest] "${r.command}" ×${r.iterations}  →  ${ms(r.totalMs)} ms`,
    "font-weight:bold;color:#9cdcfe",
  );
  console.table({ "latency enter→command_end (ms)": roundStats(r.latency) });
  console.log(
    "first-event enter→first patch (ms):",
    `p50 ${ms(r.firstEventP50)}`,
    `p99 ${ms(r.firstEventP99)}`,
  );
  console.log(
    "dispatch reducer+setStore (ms):",
    `p50 ${ms(r.dispatchP50)}`,
    `p99 ${ms(r.dispatchP99)}`,
    `max ${ms(r.dispatchMax)}`,
    `· ${r.dispatchSamples} samples`,
  );
  console.log(
    "render canvas RAF (ms):",
    `p50 ${ms(r.renderFrameP50)}`,
    `p99 ${ms(r.renderFrameP99)}`,
    `max ${ms(r.renderFrameMax)}`,
    `· ${r.renderFrameSamples} frames`,
  );
  console.log(
    `completed ${r.completed}/${r.iterations}  ·  events ${r.events}  ·  timeouts ${r.timeouts}`,
  );
  if (r.timeouts > 0) {
    console.warn(
      `[perga autotest] ${r.timeouts} 条命令在 ${MAX_COMMAND_MS}ms 内没等到 command_end,` +
        "汇总有偏差 ── 确认 shell 已 source 集成脚本,且命令没进交互态(vim/分页器)",
    );
  }
  console.groupEnd();
}

/// 保留一位小数,console 输出用。
function ms(n: number): number {
  return Math.round(n * 10) / 10;
}

function roundStats(s: LatencyStats): Record<string, number> {
  return {
    min: ms(s.min),
    p50: ms(s.p50),
    p90: ms(s.p90),
    p99: ms(s.p99),
    max: ms(s.max),
    mean: ms(s.mean),
  };
}
