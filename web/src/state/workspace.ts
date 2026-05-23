// Workspace:多 tab + tab 内二叉分屏的响应式容器。
//
// 两层分工:
// - `pane_tree.ts` 是纯树模型(值);本文件把它接到 Solid `createStore`,并持有
//   按 leaf id 索引的 `LeafSession` 注册表(资源)。树变换全部委派给 pane_tree,
//   本文件只负责「树编辑 + session 生命周期」的原子配对。
// - session 归属在 workspace,不在组件:split 重建树时 Solid 可能 remount leaf
//   组件,但 leaf id(及其 PTY)必须存活 ── 把 socket 绑在数据而非组件上。
//
// 不变量:workspace 永远 ≥1 tab,每 tab 永远 ≥1 活 pane。任何会破坏它的操作
// 改为 respawn(决策 B,数据模型无空态)。

import { createStore, produce } from "solid-js/store";

import { type Transport, transportFactory } from "../net";
import type { AutoBench } from "../util/autotest";
import type { PerfTracker } from "../util/perf";
import {
  type LeafId,
  type PaneTree,
  type SplitAxis,
  type SplitPath,
  closeFocused as treeCloseFocused,
  focusNeighbor as treeFocusNeighbor,
  hasLeaf,
  leafCount,
  leafIds,
  leafTree,
  setRatio as treeSetRatio,
  splitFocused as treeSplitFocused,
} from "./pane_tree";
import type { ProtocolEvent, TerminalSize } from "./protocol";
import { type SessionStore, createSessionStore } from "./session_store";
import type { ClientMessage } from "./wire";

export type FocusDir = "up" | "down" | "left" | "right";

export type Tab = {
  id: string;
  tree: PaneTree;
  /** active leaf;不变量:始终是 `tree` 中存在的 leaf。每 tab 独立保留。 */
  focusedLeaf: LeafId;
};

export type WorkspaceState = {
  /** 不变量:非空。 */
  tabs: Tab[];
  /** 不变量:0 <= activeTab < tabs.length。 */
  activeTab: number;
};

/**
 * 一个 pane 需要的全部资源。leaf id 铸造时创建,leaf 离树时 dispose。
 * socket 完全封装在内 ── 不暴露裸 socket,也就没有可空 socket 泄漏到外面。
 *
 * `profileId` 在 leaf 创建时一次性绑定:有值 → SSH backend(`?profile=<id>`);
 * 缺省 → 本地 shell。leaf 整个生命周期内固定,不支持 mid-session 切换
 * backend(那等价于关掉重开)。
 */
export type LeafSession = {
  id: LeafId;
  store: SessionStore;
  /** 此 leaf 绑定的 profile;`undefined` 表示本地 shell。 */
  readonly profileId: string | undefined;
  /** 构造并连接 socket。幂等:已连则忽略(组件 remount 安全)。 */
  connect(rows: number, cols: number): void;
  send(msg: ClientMessage): void;
  /** 关闭 socket。由 workspace 在 leaf 离树时调用。 */
  dispose(): void;
  /** renderer 渲染回调的 perf 漏斗 ── 内部路由到 perf overlay / autotest。 */
  reportRenderScheduled(): void;
  reportRenderFrame(durationMs: number): void;
  /** 已排队的 render 在 flush 前被取消(组件卸载)。 */
  reportRenderCancelled(): void;
};

export type Workspace = {
  state: WorkspaceState;
  newTab(): void;
  /** 用指定 host profile id 开新 tab,leaf socket 走 SSH backend。 */
  newTabWithProfile(profileId: string): void;
  closeTab(tabId: string): void;
  switchTab(index: number): void;
  nextTab(): void;
  splitFocused(axis: SplitAxis): void;
  closeFocused(): void;
  focusNeighbor(dir: FocusDir): void;
  focusLeaf(id: LeafId): void;
  setRatio(tabId: string, path: SplitPath, ratio: number): void;
  sessionFor(id: LeafId): LeafSession;
  /** active tab 的 focused leaf 标题,空则 fallback "shell"。 */
  tabTitle(tabId: string): string;
  focusedSession(): LeafSession;
};

// store 在拿到第一帧 Init 前需要一个合法 size;PaneLeaf 挂载测量后真实尺寸
// 通过 connect 进入 WS query,第一帧 Init 一到就替换。
const FALLBACK_SIZE: TerminalSize = { rows: 24, cols: 80 };

export function createWorkspace(
  perfTracker?: PerfTracker,
  autoBench?: AutoBench,
): Workspace {
  const registry = new Map<LeafId, LeafSession>();

  // 单调 id 计数器,不复用 ── 陈旧引用不会别名到新 leaf / tab。
  let leafSeq = 0;
  let tabSeq = 0;

  // state 在下方 createStore 才赋值;leaf session 的闭包**惰性**读取它(只在
  // 收到 WS 事件时,远晚于 createWorkspace 返回),所以这里前向引用是安全的。
  let state: WorkspaceState;

  const createLeafSession = (
    id: LeafId,
    profileId: string | undefined,
  ): LeafSession => {
    const store = createSessionStore(FALLBACK_SIZE);
    let transport: Transport | null = null;

    // 此 leaf 是否是 active tab 的 focused leaf ── 决定是否把事件喂给 autotest。
    const isFocused = (): boolean => {
      const tab = state.tabs[state.activeTab];
      return tab !== undefined && tab.focusedLeaf === id;
    };

    // 后台 tab 的 pane renderer 已卸载(不渲染),但 WS 保活、dispatch 照跑。
    // 后台噪声程序会持续耗主线程 ── 已知限制,见仓库根 TODO.md。
    const onEvent = (ev: ProtocolEvent): void => {
      if (!perfTracker?.isEnabled()) {
        store.dispatch(ev);
        return;
      }
      const t0 = performance.now();
      store.dispatch(ev);
      const dispatchMs = performance.now() - t0;
      perfTracker.recordDispatch(dispatchMs);
      // autotest 在驱动 focused pane;只把它那条事件流喂进去。
      if (isFocused()) {
        autoBench?.onEvent(dispatchMs);
        if (ev.type === "command_end") autoBench?.onCommandEnd();
      }
    };

    return {
      id,
      store,
      profileId,
      connect(rows, cols) {
        if (transport) return; // 幂等
        transport = transportFactory({
          rows,
          cols,
          profileId,
          onEvent,
          onClose: ({ code, reason }) => {
            console.warn(
              `perga.transport.closed leaf=${id} code=${code} reason=${reason}`,
            );
          },
          onError: (msg) =>
            console.warn(`perga.transport.error leaf=${id} ${msg}`),
          perfTracker: perfTracker?.isEnabled() ? perfTracker : undefined,
        });
      },
      send(msg) {
        transport?.send(msg);
      },
      dispose() {
        transport?.close();
        transport = null;
      },
      // render 的 scheduled / frame / cancelled 三者必须成对计数,**不能**按
      // isFocused 过滤 ── 焦点会在 schedule 与 resolve 之间变化(切 tab),
      // 过滤会让 autotest 的 pending 计数失衡。基准跑动时只有 focused pane
      // 在渲染,后台 pane 静默,聚合计数等价于 focused pane。
      reportRenderScheduled() {
        autoBench?.onRenderScheduled();
      },
      reportRenderFrame(durationMs) {
        perfTracker?.recordRenderFrame(durationMs);
        autoBench?.onRenderFrame(durationMs);
      },
      reportRenderCancelled() {
        autoBench?.onRenderCancelled();
      },
    };
  };

  // 铸造一个 leaf + 它的 session,登记进注册表,返回 leaf id。
  // `profileId` 缺省 = 本地 shell;指定 = SSH backend。
  const createLeaf = (profileId?: string): LeafId => {
    const id: LeafId = `leaf-${leafSeq++}`;
    registry.set(id, createLeafSession(id, profileId));
    return id;
  };

  const disposeLeaf = (id: LeafId): void => {
    registry.get(id)?.dispose();
    registry.delete(id);
  };

  // 造一个全新 tab:一个 leaf + 它的 session。`profileId` 透到 leaf。
  // split 出来的子 pane 不继承 profile —— split 总是开本地 shell,因为
  // 「在 SSH 远端再开一个 SSH 子会话」不是 v1 的产品语义(那需要 Multi-channel
  // 或嵌套 ssh,留给后续)。
  const makeTab = (profileId?: string): Tab => {
    const leaf = createLeaf(profileId);
    return { id: `tab-${tabSeq++}`, tree: leafTree(leaf), focusedLeaf: leaf };
  };

  const [store, setStore] = createStore<WorkspaceState>({
    tabs: [makeTab()],
    activeTab: 0,
  });
  state = store;

  const sessionFor = (id: LeafId): LeafSession => {
    const session = registry.get(id);
    if (!session) throw new Error(`workspace: leaf ${id} 无对应 session`);
    return session;
  };

  const focusedSession = (): LeafSession =>
    sessionFor(store.tabs[store.activeTab].focusedLeaf);

  const newTab = (): void => {
    const tab = makeTab();
    setStore(
      produce((s) => {
        s.tabs.push(tab);
        s.activeTab = s.tabs.length - 1;
      }),
    );
  };

  const newTabWithProfile = (profileId: string): void => {
    const tab = makeTab(profileId);
    setStore(
      produce((s) => {
        s.tabs.push(tab);
        s.activeTab = s.tabs.length - 1;
      }),
    );
  };

  const closeTab = (tabId: string): void => {
    const idx = store.tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return;
    const victims = leafIds(store.tabs[idx].tree);

    if (store.tabs.length === 1) {
      // 最后一个 tab:不进空态,respawn 一个全新 tab(决策 B 的 tab 层版本)。
      const fresh = makeTab();
      for (const leaf of victims) disposeLeaf(leaf);
      setStore(
        produce((s) => {
          s.tabs[0] = fresh;
          s.activeTab = 0;
        }),
      );
      return;
    }

    for (const leaf of victims) disposeLeaf(leaf);
    setStore(
      produce((s) => {
        s.tabs.splice(idx, 1);
        if (s.activeTab > idx) s.activeTab -= 1;
        if (s.activeTab > s.tabs.length - 1) s.activeTab = s.tabs.length - 1;
      }),
    );
  };

  const switchTab = (index: number): void => {
    const clamped = Math.max(0, Math.min(index, store.tabs.length - 1));
    setStore("activeTab", clamped);
  };

  const nextTab = (): void => {
    setStore("activeTab", (store.activeTab + 1) % store.tabs.length);
  };

  const splitFocused = (axis: SplitAxis): void => {
    const idx = store.activeTab;
    const tab = store.tabs[idx];
    const edit = treeSplitFocused(tab.tree, tab.focusedLeaf, axis, createLeaf());
    setStore(
      produce((s) => {
        s.tabs[idx].tree = edit.tree;
        s.tabs[idx].focusedLeaf = edit.focus;
      }),
    );
  };

  const closeFocused = (): void => {
    const idx = store.activeTab;
    const tab = store.tabs[idx];

    if (leafCount(tab.tree) > 1) {
      // 普通情况:tab 内折叠 split。
      const closing = tab.focusedLeaf;
      const edit = treeCloseFocused(tab.tree, closing);
      disposeLeaf(closing);
      setStore(
        produce((s) => {
          s.tabs[idx].tree = edit.tree;
          s.tabs[idx].focusedLeaf = edit.focus;
        }),
      );
      return;
    }

    // tab 只剩一个 pane:关掉它 = 关整个 tab(§6),由 closeTab 处理「最后
    // 一个 tab 则 respawn」的分叉。
    closeTab(tab.id);
  };

  const focusNeighbor = (dir: FocusDir): void => {
    const idx = store.activeTab;
    const tab = store.tabs[idx];
    const next = treeFocusNeighbor(tab.tree, tab.focusedLeaf, dir);
    if (next !== tab.focusedLeaf) setStore("tabs", idx, "focusedLeaf", next);
  };

  const focusLeaf = (id: LeafId): void => {
    const idx = store.activeTab;
    // 只接受属于 active tab 的 leaf ── 跨 tab focus 是无意义状态。
    if (!hasLeaf(store.tabs[idx].tree, id)) return;
    setStore("tabs", idx, "focusedLeaf", id);
  };

  const setRatio = (
    tabId: string,
    path: SplitPath,
    ratio: number,
  ): void => {
    const idx = store.tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return;
    setStore("tabs", idx, "tree", treeSetRatio(store.tabs[idx].tree, path, ratio));
  };

  const tabTitle = (tabId: string): string => {
    const tab = store.tabs.find((t) => t.id === tabId);
    if (!tab) return "shell";
    // store.state.title 是 Solid store,JSX 内读取即建立订阅 → 标题随焦点 pane
    // 的 OSC 标题更新(决策 C)。
    const title = registry.get(tab.focusedLeaf)?.store.state.title;
    return title && title.length > 0 ? title : "shell";
  };

  // autotest 通过这层间接始终路由到当前 focused leaf ── attach 一次即可,
  // 焦点切换时无需重接。
  autoBench?.attach(
    (msg) => focusedSession().send(msg),
    () => focusedSession().store.state.exited,
  );

  return {
    state: store,
    newTab,
    newTabWithProfile,
    closeTab,
    switchTab,
    nextTab,
    splitFocused,
    closeFocused,
    focusNeighbor,
    focusLeaf,
    setRatio,
    sessionFor,
    tabTitle,
    focusedSession,
  };
}
