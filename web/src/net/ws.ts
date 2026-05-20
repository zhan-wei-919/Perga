// WebSocket client for a single perga-server session.
//
// **Phase 1 显式不做 auto-reconnect**:重连意味着要拿一个 fresh `init` 来对齐
// 本地 grid,但服务端没存 session state(WS 一断 PTY 就死)── 重连等价于
// 「开新会话」,UX 上得明确告诉用户,不能偷偷重连让人以为还连着原来的。
// 真要做要在 Phase 4 一起做。
//
// **Send 队列**:WS readyState 不到 OPEN 时把消息暂存,onopen 后 flush。
// 关闭后 send 直接 drop ── 配合 reactive store 的 `exited` 标记,UI 不该再
// 发送任何输入。

import type { ProtocolEvent } from "../state/protocol";
import type { ClientMessage } from "../state/wire";
import type { PerfTracker } from "../util/perf";

export type SessionSocketOpts = {
  /** 1..=1000 */
  rows: number;
  /** 1..=1000 */
  cols: number;
  /** server 端事件回调。已经反序列化好。 */
  onEvent: (ev: ProtocolEvent) => void;
  /** WS 关闭(server 主动或网络断)时调用。`code` / `reason` 来自 CloseEvent。 */
  onClose: (info: { code: number; reason: string }) => void;
  /** 反序列化失败 / 其他客户端侧错误。不会停 socket(继续等下一条)。 */
  onError?: (msg: string) => void;
  /** 可选 perf 采样器。`?perf=1` 时由 App 注入,默认 undefined 零开销。 */
  perfTracker?: PerfTracker;
  /** 用于测试覆盖 `new WebSocket(url)` ── 生产代码不传。 */
  factory?: (url: string) => WebSocket;
};

export class SessionSocket {
  private ws: WebSocket | null = null;
  private queue: ClientMessage[] = [];
  private closedByUs = false;

  constructor(private opts: SessionSocketOpts) {}

  /** 同步发起连接;onEvent 在收到第一条 init 帧后被调用。 */
  connect(): void {
    const url = buildUrl(this.opts.rows, this.opts.cols);
    const factory = this.opts.factory ?? ((u) => new WebSocket(u));
    const ws = factory(url);

    ws.onopen = () => this.flushQueue();
    ws.onmessage = (e) => this.handleMessage(e);
    ws.onclose = (e) => {
      // closedByUs 时不再向上 fire ── 上层早就知道。
      if (!this.closedByUs) {
        this.opts.onClose({ code: e.code, reason: e.reason });
      }
    };
    ws.onerror = () => {
      // 浏览器 WebSocket 的 onerror 信息有限,语义可观察的只有「onclose 会
      // 紧跟着发」。这里只 log;真正的状态在 onclose 上报。
      this.opts.onError?.("websocket error (see onclose)");
    };

    this.ws = ws;
  }

  /** 不带版本号、不做幂等;Phase 1 假设上层不会重复 close。 */
  close(): void {
    this.closedByUs = true;
    this.ws?.close();
    this.ws = null;
    this.queue.length = 0;
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      this.queue.push(msg);
    }
    // readyState = CLOSING / CLOSED:丢弃。上层会观察到 exited / onClose。
  }

  private flushQueue(): void {
    if (!this.ws) return;
    for (const msg of this.queue) {
      this.ws.send(JSON.stringify(msg));
    }
    this.queue.length = 0;
  }

  private handleMessage(e: MessageEvent): void {
    if (typeof e.data !== "string") {
      // server 现在只发 text frames;binary 出现说明协议出错了。
      this.opts.onError?.("unexpected binary frame");
      return;
    }
    const text = e.data;
    const tracker = this.opts.perfTracker;

    let parsed: unknown;
    const t0 = tracker ? performance.now() : 0;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      this.opts.onError?.(`parse error: ${(err as Error).message}`);
      return;
    }
    if (tracker) {
      tracker.recordParse(performance.now() - t0, text.length);
    }
    // 不做更深 validate ── server 端 schema 是 Rust serde 强类型生成,信任契约。
    this.opts.onEvent(parsed as ProtocolEvent);
  }
}

/// `/ws?rows=&cols=` ── 同源相对路径,dev 模式由 vite proxy 转发到 7777 端口,
/// Tauri 模式下两端同进程后这层 URL 还会改成 IPC,API 一致。
function buildUrl(rows: number, cols: number): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws?rows=${rows}&cols=${cols}`;
}
