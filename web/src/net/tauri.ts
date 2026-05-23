// Tauri 形态下的 session transport。把 Tauri 的 `invoke` + `event` 包装成
// 与 `WsTransport` 同形态的接口。
//
// 工作流:
// 1. 同步构造时 spawn 一个 async setup 任务 — 前端先生成 `sessionId`,
//    `listen('session_event:<id>', ...)`,再调 `session_open`。
// 2. setup 期间 `send` 进入 queue;setup 结束后 flush。
// 3. 后端发的 `ProtocolEvent` 通过 Tauri event 直达回调,无 binary、无 JSON parse。
// 4. `close` 主动 unlisten + 调 `session_close`,registry 那边同步 drop session。
//
// `@tauri-apps/api/core` 与 `@tauri-apps/api/event` 用**动态 import** 加载,
// 让 vite 把 Tauri 路径拆成独立 chunk —— 浏览器 dev 永远不会拉这个 chunk。

import type { ProtocolEvent } from "../state/protocol";
import type { ClientMessage } from "../state/wire";
import type { Transport, TransportFactory, TransportOpts } from "./transport";

type TauriCore = typeof import("@tauri-apps/api/core");
type TauriEvent = typeof import("@tauri-apps/api/event");

let cachedApi: Promise<{ core: TauriCore; event: TauriEvent }> | null = null;

/// 延迟加载 Tauri API。多 session 共享同一 Promise,避免重复 import 与解析。
function loadTauriApi(): Promise<{ core: TauriCore; event: TauriEvent }> {
  if (!cachedApi) {
    cachedApi = Promise.all([
      import("@tauri-apps/api/core"),
      import("@tauri-apps/api/event"),
    ]).then(([core, event]) => ({ core, event }));
  }
  return cachedApi;
}

export const createTauriTransport: TransportFactory = (
  opts: TransportOpts,
): Transport => {
  const queue: ClientMessage[] = [];
  // `state` 故意宽化为 `string`,避免 TS 控制流把字面量 union 在 await
  // 之间错误窄化(setup 闭包与 close() 是异步并发的,TS 静态分析看不到 close
  // 的赋值)。
  const ctl: {
    state: string;
    sessionId: string | null;
    invoke: TauriCore["invoke"] | null;
    unlisten: (() => void) | null;
  } = {
    state: "starting",
    sessionId: null,
    invoke: null,
    unlisten: null,
  };

  const onError = (msg: string): void => {
    opts.onError?.(msg);
  };

  // Setup 任务:整段在 IIFE async 里跑,失败走 onClose 通知 UI(等价 WS 的 onclose)。
  void (async () => {
    try {
      const { core, event } = await loadTauriApi();
      if (ctl.state === "closed") return;
      ctl.invoke = core.invoke;

      const id = newSessionId();
      ctl.unlisten = await event.listen<ProtocolEvent>(
        `session_event:${id}`,
        (e) => opts.onEvent(e.payload),
      );
      if (ctl.state === "closed") {
        ctl.unlisten();
        ctl.unlisten = null;
        return;
      }

      await core.invoke<void>("session_open", {
        sessionId: id,
        profileId: opts.profileId ?? null,
        rows: opts.rows,
        cols: opts.cols,
      });
      if (ctl.state === "closed") {
        // 已被前端 close,session 也要回收。
        await safeInvoke(core.invoke, "session_close", { sessionId: id });
        return;
      }
      ctl.sessionId = id;

      ctl.state = "open";
      // Flush queue:前端在 setup 期间提前发的输入此刻补打。
      for (const msg of queue) {
        await safeInvoke(core.invoke, "session_input", { sessionId: id, msg });
      }
      queue.length = 0;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (ctl.unlisten) {
        ctl.unlisten();
        ctl.unlisten = null;
      }
      onError(`tauri session_open failed: ${msg}`);
      // 没起来 — 走 onClose 通知,前端 pane 显示 SessionError 类似的提示。
      ctl.state = "closed";
      opts.onClose({ code: 0, reason: msg });
    }
  })();

  return {
    send(msg: ClientMessage): void {
      if (ctl.state === "closed") return;
      if (ctl.state === "starting" || !ctl.invoke || !ctl.sessionId) {
        queue.push(msg);
        return;
      }
      const id = ctl.sessionId;
      const fn = ctl.invoke;
      void safeInvoke(fn, "session_input", { sessionId: id, msg }).catch((e) =>
        onError(`session_input: ${e instanceof Error ? e.message : String(e)}`),
      );
    },
    close(): void {
      if (ctl.state === "closed") return;
      ctl.state = "closed";
      if (ctl.unlisten) {
        ctl.unlisten();
        ctl.unlisten = null;
      }
      if (ctl.invoke && ctl.sessionId) {
        const fn = ctl.invoke;
        const id = ctl.sessionId;
        void safeInvoke(fn, "session_close", { sessionId: id });
      }
    },
  };
};

function newSessionId(): string {
  return crypto.randomUUID();
}

/// Tauri invoke 包装:把错误归并到 Promise.reject。command 返回 String 错误时
/// Tauri 默认把它 throw 出来,这里只是显式归一化。
async function safeInvoke(
  invoke: TauriCore["invoke"],
  cmd: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return invoke(cmd, args);
}
