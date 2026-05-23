// 运行时按 `isTauri()` 选 transport 实现。一处分流,工厂导出后业务代码不知道差异。

import { isTauri } from "../util/platform";
import { createTauriTransport } from "./tauri";
import type { TransportFactory } from "./transport";
import { createWsTransport } from "./ws";

/// 由 `isTauri()` 在模块求值时一次性挑选,以后 `LeafSession` 每次连接都走这个。
/// 没有"切换 transport"的运行时分支 —— Tauri / 浏览器是互斥构建态。
export const transportFactory: TransportFactory = isTauri()
  ? createTauriTransport
  : createWsTransport;

export type { Transport, TransportOpts, TransportClose, TransportFactory } from "./transport";
