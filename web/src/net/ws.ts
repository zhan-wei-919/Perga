// WebSocket session transport(dev 浏览器形态)。Tauri 打包形态走 `./tauri.ts`,
// 工厂在 `./index.ts` 二选一。
//
// **Phase 1 显式不做 auto-reconnect**:重连意味着要拿一个 fresh `init` 来对齐
// 本地 grid,但服务端没存 session state(WS 一断 PTY 就死)── 重连等价于
// 「开新会话」,UX 上得明确告诉用户,不能偷偷重连让人以为还连着原来的。
//
// **Send 队列**:WS readyState 不到 OPEN 时把消息暂存,onopen 后 flush。
// 关闭后 send 直接 drop ── 配合 reactive store 的 `exited` 标记,UI 不该再
// 发送任何输入。

import type { ProtocolEvent } from "../state/protocol";
import type { ClientMessage } from "../state/wire";
import type { Transport, TransportFactory, TransportOpts } from "./transport";

export type SessionSocketOpts = TransportOpts & {
  /** 用于测试覆盖 `new WebSocket(url)` ── 生产代码不传。 */
  factory?: (url: string) => WebSocket;
};

/// WebSocket 客户端核心。`SessionSocket` 类保留独立形态供测试构造,
/// 工厂 [`createWsTransport`] 在它之上包成 `Transport` 接口对外暴露。
export class SessionSocket {
  private ws: WebSocket | null = null;
  private queue: ClientMessage[] = [];
  private closedByUs = false;

  constructor(private opts: SessionSocketOpts) {}

  /** 同步发起连接;onEvent 在收到第一条 init 帧后被调用。 */
  connect(): void {
    const url = buildUrl(this.opts.rows, this.opts.cols, this.opts.profileId);
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

/// `WsTransport` 工厂 —— 把 `SessionSocket` 包成统一 Transport 接口。
/// 同步返回 handle,内部已经 `connect()`(WS 自身就是异步开 socket)。
export const createWsTransport: TransportFactory = (opts: TransportOpts): Transport => {
  const socket = new SessionSocket(opts);
  socket.connect();
  return {
    send: (msg) => socket.send(msg),
    close: () => socket.close(),
  };
};

/// `/ws?rows=&cols=[&profile=<id>]` ── 同源相对路径,dev 模式由 vite proxy
/// 转发到 7777 端口。Tauri 模式走 [`./tauri.ts`] 不走本路径。
///
/// `profileId` 缺省 = 本地 shell;指定 = server 走 SSH backend。
function buildUrl(rows: number, cols: number, profileId?: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const base = `${proto}//${window.location.host}/ws?rows=${rows}&cols=${cols}`;
  if (profileId === undefined || profileId === "") {
    return base;
  }
  return `${base}&profile=${encodeURIComponent(profileId)}`;
}
