// 前端 → 后端的 session transport 抽象。一个会话一个 Transport;构造时连接,
// `close` 时清理。Transport 持有的资源(WS / Tauri listen unsubscribe / 队列)
// 全部在实现内部,调用方只看到 send / close。
//
// 两份实现:
// - `WsTransport`(`./ws.ts`)走 dev 浏览器形态的 `perga-server` WebSocket。
// - `TauriTransport`(`./tauri.ts`)走 Tauri IPC(`invoke` + `event`)。
//
// `./index.ts` 的 `transportFactory` 在运行时按 `isTauri()` 二选一。

import type { ProtocolEvent } from "../state/protocol";
import type { ClientMessage } from "../state/wire";
import type { PerfTracker } from "./../util/perf";

/// WS / IPC 通用的关闭事件信号。WS 走 `CloseEvent.code/reason`;
/// Tauri 失败 / 用户 close 时构造一条 `{ code: 0, reason }` 模拟,UI 不区分。
export type TransportClose = {
  code: number;
  reason: string;
};

/// 一个 session transport 句柄。
export interface Transport {
  send(msg: ClientMessage): void;
  close(): void;
}

export interface TransportOpts {
  /** 1..=1000 */
  rows: number;
  /** 1..=1000 */
  cols: number;
  /** 可选 host profile id;有值时走 SSH backend,否则本地 shell。 */
  profileId?: string;
  /** 后端事件回调,已经反序列化好(不是 raw text)。 */
  onEvent: (ev: ProtocolEvent) => void;
  /** 后端断开 / 网络错误 / 用户 close 都会调一次(且仅一次,如果不是 closedByUs)。 */
  onClose: (info: TransportClose) => void;
  /** 客户端侧错误(parse 失败 / Tauri command 异常),不停止 transport。 */
  onError?: (msg: string) => void;
  /** 可选 perf 采样器,WS 路径会用。 */
  perfTracker?: PerfTracker;
}

/// 工厂函数 —— 同步返回 Transport(内部初始化可异步,send 自带 queue)。
export type TransportFactory = (opts: TransportOpts) => Transport;
