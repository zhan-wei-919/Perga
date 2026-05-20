// App 顶层组件:workspace root。
//
// 装配 = TabBar(顶) + 当前 active tab 的 PaneTreeView(主区) + 一个 capture
// 阶段的 workspace 快捷键拦截器。每个终端 pane 的 WS / store / canvas / 输入
// 都下沉到 `PaneLeaf`(经 `PaneTreeView` 递归渲染);App 自己不直接碰 socket。
//
// PaneTreeView 用 `<Show keyed>` 按 active tab 对象身份重建:切 tab 整体重挂
// (后台 tab 的 canvas 卸载、WS 保活),tab 内 split/close 不触发重挂。

import { type Component, Show, onCleanup, onMount } from "solid-js";

import {
  type WorkspaceAction,
  matchWorkspaceShortcut,
} from "../input/workspace_shortcuts";
import { createWorkspace } from "../state/workspace";
import { AutoBench } from "../util/autotest";
import { PerfTracker, shouldEnablePerf } from "../util/perf";
import { AutoTestButton } from "./autotest_button";
import { PaneTreeView } from "./pane_tree_view";
import { PerfOverlay } from "./perf_overlay";
import { TabBar } from "./tab_bar";

export const App: Component = () => {
  const perfTracker = new PerfTracker(shouldEnablePerf());
  // autotest 由 workspace 接到「当前 focused leaf」;perf 计时聚合到 perfTracker。
  const autoBench = new AutoBench();
  const workspace = createWorkspace(perfTracker, autoBench);

  const applyShortcut = (action: WorkspaceAction): void => {
    switch (action.kind) {
      case "split":
        workspace.splitFocused(action.axis);
        break;
      case "close":
        workspace.closeFocused();
        break;
      case "newTab":
        workspace.newTab();
        break;
      case "switchTab":
        workspace.switchTab(action.index);
        break;
      case "nextTab":
        workspace.nextTab();
        break;
      case "focus":
        workspace.focusNeighbor(action.dir);
        break;
    }
  };

  onMount(() => {
    // 唯一的 workspace 快捷键拦截器:capture 阶段先于 focused pane 的 bubble
    // 阶段 keydown。命中即 stopPropagation,pane 收不到 ── 快捷键不漏进 PTY。
    const onShortcut = (e: KeyboardEvent): void => {
      const action = matchWorkspaceShortcut(e);
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      applyShortcut(action);
    };
    document.addEventListener("keydown", onShortcut, { capture: true });
    onCleanup(() =>
      document.removeEventListener("keydown", onShortcut, { capture: true }),
    );
  });

  return (
    <div style={rootStyle}>
      <TabBar workspace={workspace} />
      <div style={paneAreaStyle}>
        <Show
          when={workspace.state.tabs[workspace.state.activeTab]}
          keyed
        >
          {(tab) => <PaneTreeView tab={tab} workspace={workspace} />}
        </Show>
      </div>
      <Show when={perfTracker.isEnabled()}>
        <PerfOverlay tracker={perfTracker} />
        <AutoTestButton bench={autoBench} />
      </Show>
    </div>
  );
};

const rootStyle: Record<string, string> = {
  width: "100vw",
  height: "100vh",
  display: "flex",
  "flex-direction": "column",
  overflow: "hidden",
  background: "#1e1e1e",
};

const paneAreaStyle: Record<string, string> = {
  flex: "1",
  position: "relative",
  // flex 子节点能收缩到内容以下的必要条件;否则 pane 区会被内容撑破。
  "min-width": "0",
  "min-height": "0",
  overflow: "hidden",
};
