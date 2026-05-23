// App 顶层组件:workspace root。
//
// 装配 = TabBar(顶) + 当前 active tab 的 PaneTreeView(主区) + 一个 capture
// 阶段的 workspace 快捷键拦截器。每个终端 pane 的 WS / store / renderer / 输入
// 都下沉到 `PaneLeaf`(经 `PaneTreeView` 递归渲染);App 自己不直接碰 socket。
//
// PaneTreeView 用 `<Show keyed>` 按 active tab 对象身份重建:切 tab 整体重挂
// (后台 tab 的 renderer 卸载、WS 保活),tab 内 split/close 不触发重挂。

import {
  type Component,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import {
  type WorkspaceAction,
  matchWorkspaceShortcut,
} from "../input/workspace_shortcuts";
import {
  type ZoomAction,
  matchZoomShortcut,
} from "../input/zoom_shortcuts";
import { applyTheme } from "../render/theme";
import { createSettings } from "../state/settings";
import { SettingsContext } from "../state/settings_context";
import { createWorkspace } from "../state/workspace";
import { AutoBench } from "../util/autotest";
import { PerfTracker, shouldEnablePerf } from "../util/perf";
import { AutoTestButton } from "./autotest_button";
import { Modal } from "./modal";
import { PaneTreeView } from "./pane_tree_view";
import { PerfOverlay } from "./perf_overlay";
import { SettingsPanel } from "./settings_panel";
import { TabBar } from "./tab_bar";

export const App: Component = () => {
  const perfTracker = new PerfTracker(shouldEnablePerf());
  // autotest 由 workspace 接到「当前 focused leaf」;perf 计时聚合到 perfTracker。
  const autoBench = new AutoBench();
  const workspace = createWorkspace(perfTracker, autoBench);

  const settings = createSettings();
  // 同步应用初始主题:在返回 JSX 前写好 :root CSS 变量,首帧即正确配色、不闪。
  applyTheme(settings.state.themeId);
  // 后续切主题:重写 CSS 变量 → chrome + DOM 命令块零重渲染换肤。
  createEffect(() => applyTheme(settings.state.themeId));

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

  const applyZoom = (action: ZoomAction): void => {
    if (action.kind === "zoomIn") settings.zoomIn();
    else if (action.kind === "zoomOut") settings.zoomOut();
    else settings.zoomReset();
  };

  const [settingsOpen, setSettingsOpen] = createSignal(false);

  // tab 栏自动隐藏:顶部 8px 是触发区,hover 后展开成 30px 的 tab 区;
  // 鼠标离开这整个 hover 区就立即收起。不要按 tab 数量常显,否则多 tab
  // 场景会表现成“移走但不消失”。
  const [tabHovering, setTabHovering] = createSignal(false);
  const tabBarVisible = (): boolean => tabHovering();

  onMount(() => {
    // 唯一的快捷键拦截器:capture 阶段先于 focused pane 的 bubble 阶段
    // keydown。命中即 stopPropagation,pane 收不到 ── 快捷键不漏进 PTY。
    const onShortcut = (e: KeyboardEvent): void => {
      const wsAction = matchWorkspaceShortcut(e);
      if (wsAction) {
        e.preventDefault();
        e.stopPropagation();
        applyShortcut(wsAction);
        return;
      }
      const zoomAction = matchZoomShortcut(e);
      if (zoomAction) {
        e.preventDefault();
        e.stopPropagation();
        applyZoom(zoomAction);
      }
    };
    document.addEventListener("keydown", onShortcut, { capture: true });
    onCleanup(() =>
      document.removeEventListener("keydown", onShortcut, { capture: true }),
    );
  });

  return (
    <SettingsContext.Provider value={settings}>
      <div style={rootStyle}>
        <div
          style={tabHoverZoneStyle(tabBarVisible())}
          onMouseEnter={() => setTabHovering(true)}
          onMouseLeave={() => setTabHovering(false)}
        >
          <TabBar
            workspace={workspace}
            onOpenSettings={() => setSettingsOpen(true)}
            visible={tabBarVisible()}
          />
        </div>
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
        <Show when={settingsOpen()}>
          <Modal onClose={() => setSettingsOpen(false)}>
            <SettingsPanel
              onConnectProfile={(profileId) => {
                workspace.newTabWithProfile(profileId);
                setSettingsOpen(false);
              }}
            />
          </Modal>
        </Show>
      </div>
    </SettingsContext.Provider>
  );
};

const rootStyle: Record<string, string> = {
  width: "100vw",
  height: "100vh",
  // position:relative ── 给 absolute 定位的 tab 栏当锚点。
  position: "relative",
  display: "flex",
  "flex-direction": "column",
  overflow: "hidden",
  background: "var(--term-background)",
};

/// pane 区。tab 栏是 hover 浮层,不预留顶部空间 → 显隐不触发 terminal resize。
const paneAreaStyle: Record<string, string> = {
  flex: "1",
  position: "relative",
  // flex 子节点能收缩到内容以下的必要条件;否则 pane 区会被内容撑破。
  "min-width": "0",
  "min-height": "0",
  overflow: "hidden",
};

/// 顶部 hover 区:隐藏时只留 8px 触发条;展开时覆盖完整 tab 栏高度。
function tabHoverZoneStyle(visible: boolean): Record<string, string> {
  return {
    position: "absolute",
    top: "0",
    left: "0",
    right: "0",
    height: visible ? "30px" : "8px",
    "z-index": "110",
    overflow: "visible",
  };
}
