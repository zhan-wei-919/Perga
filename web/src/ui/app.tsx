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
  createResource,
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
import { detectPlatform } from "../util/platform";
import { PerfTracker, shouldEnablePerf } from "../util/perf";
import { AutoTestButton } from "./autotest_button";
import { Modal } from "./modal";
import { PaneTreeView } from "./pane_tree_view";
import { PerfOverlay } from "./perf_overlay";
import { ProfilePicker } from "./profile_picker";
import { SettingsPanel } from "./settings_panel";
import { TabBar } from "./tab_bar";
import {
  WINDOW_CHROME_HEIGHT,
  WindowChrome,
  shouldShowWindowChrome,
} from "./window_chrome";

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
        if (isLocalAllowed()) {
          workspace.splitFocused(action.axis);
          break;
        }
        // 移动端没有本地 PTY;分屏必须继承当前 SSH profile,否则会创建一个
        // 必然失败的 local pane。空态 / 异常 local pane 下退回 picker。
        const profileId = workspace.focusedSession()?.profileId;
        if (profileId) workspace.splitFocused(action.axis, profileId);
        else setPickerOpen(true);
        break;
      case "close":
        workspace.closeFocused();
        break;
      case "newTab":
        // local 不允许时(mobile / 解析窗口内的 unknown)转弹 picker,
        // desktop 维持「直接开本地 shell」的旧 UX。
        if (isLocalAllowed()) workspace.newTab();
        else setPickerOpen(true);
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
  // Profile picker(平板 + 移动 + 第一次启动引导)。`forceSetup` 由 picker 内部
  // 在 0 profile 时切换;App 这里只控制开关。
  const [pickerOpen, setPickerOpen] = createSignal(false);

  // 平台探测一次:URL flag → Tauri command → 默认 desktop。createResource 让
  // 我们在 SolidJS 响应式系统里使用 async 探测结果。
  const [platform] = createResource(detectPlatform);
  const isMobile = (): boolean => platform()?.kind === "mobile";
  // 本地 shell 是否允许的二元 gate ── unknown 平台保守视作"不允许",避免
  // 解析窗口内用户点 `+ 新建 shell` / 触发 newTab shortcut 在 mobile build
  // 上意外开出无法 spawn 的 local pane。只有 explicitly desktop 才放行。
  const isLocalAllowed = (): boolean => platform()?.kind === "desktop";
  const showWindowChrome = (): boolean => shouldShowWindowChrome(platform());
  const activeTabTitle = (): string => {
    const tab = workspace.state.tabs[workspace.state.activeTab];
    return tab ? workspace.tabTitle(tab.id) : "shell";
  };

  // `createWorkspace` 数据层永远允许空(关到底就 `tabs: []`)。平台行为差异
  // 在这层用一个 reactive effect 维护:
  // - desktop:UI 不变量"tabs ≥ 1" ── effect 看到 0 就 newTab,等价于初次
  //   启动开 default shell + close-last respawn。
  // - mobile:第一次解析时弹 picker(picker 内部 0 profile 自动进 HostForm
  //   引导);后续 close 到空时**不**自动 respawn ── 本地 shell 不可达,
  //   EmptyState 的"添加远程主机"按钮是用户重入路径。
  let pickerShownOnce = false;
  createEffect(() => {
    const p = platform();
    if (!p) return; // resource 还没解析
    if (p.kind === "mobile") {
      if (!pickerShownOnce) {
        setPickerOpen(true);
        pickerShownOnce = true;
      }
      return;
    }
    // desktop:tabs.length 是 Solid store 读,自动建立订阅 ── close-last → 0
    // 触发 effect 重跑 → newTab → 1。两次 effect 跑完稳定。
    if (workspace.state.tabs.length === 0) {
      workspace.newTab();
    }
  });

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
        <Show when={showWindowChrome()}>
          <WindowChrome title={activeTabTitle()} />
        </Show>
        <div
          style={tabHoverZoneStyle(tabBarVisible(), showWindowChrome())}
          onMouseEnter={() => setTabHovering(true)}
          onMouseLeave={() => setTabHovering(false)}
        >
          <TabBar
            workspace={workspace}
            onOpenSettings={() => setSettingsOpen(true)}
            visible={tabBarVisible()}
            onPlusOverride={
              isLocalAllowed() ? undefined : () => setPickerOpen(true)
            }
          />
        </div>
        <div style={paneAreaStyle}>
          <Show
            when={workspace.state.tabs[workspace.state.activeTab]}
            keyed
            fallback={
              <EmptyState
                showLocal={isLocalAllowed()}
                onNewLocal={() => workspace.newTab()}
                onOpenPicker={() => setPickerOpen(true)}
              />
            }
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
        <Show when={pickerOpen()}>
          <Modal onClose={() => setPickerOpen(false)}>
            <ProfilePicker
              forceSetup={isMobile()}
              onConnect={(profileId) => {
                workspace.newTabWithProfile(profileId);
                setPickerOpen(false);
              }}
              onCancel={() => setPickerOpen(false)}
            />
          </Modal>
        </Show>
      </div>
    </SettingsContext.Provider>
  );
};

/// 空 workspace 占位:tab 栏在 hover 才出现,空态下用户找不到 `+`,
/// 这里直接给两个入口按钮。`showLocal` 在 mobile 上 false ── 本地 shell
/// 在移动 target 不可达,只留远程主机入口。
const EmptyState: Component<{
  showLocal: boolean;
  onNewLocal: () => void;
  onOpenPicker: () => void;
}> = (props) => (
  <div style={emptyStateStyle}>
    <div style={emptyStateInnerStyle}>
      <Show when={props.showLocal}>
        <button
          type="button"
          style={emptyStateButtonStyle}
          onClick={props.onNewLocal}
        >
          + 新建 shell
        </button>
      </Show>
      <button
        type="button"
        style={emptyStateButtonStyle}
        onClick={props.onOpenPicker}
      >
        添加远程主机
      </button>
    </div>
  </div>
);

const emptyStateStyle: Record<string, string> = {
  position: "absolute",
  inset: "0",
  display: "flex",
  "align-items": "center",
  "justify-content": "center",
  color: "var(--pg-fg-dim)",
  "font-family": "ui-monospace, monospace",
  "font-size": "13px",
};

const emptyStateInnerStyle: Record<string, string> = {
  display: "flex",
  "flex-direction": "column",
  gap: "10px",
  "min-width": "200px",
};

const emptyStateButtonStyle: Record<string, string> = {
  background: "transparent",
  color: "var(--pg-fg-dim)",
  border: "1px solid var(--pg-tabbar-border)",
  padding: "10px 16px",
  cursor: "pointer",
  "font-family": "inherit",
  "font-size": "inherit",
};

const rootStyle: Record<string, string> = {
  width: "100%",
  height: "100%",
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
function tabHoverZoneStyle(
  visible: boolean,
  hasWindowChrome: boolean,
): Record<string, string> {
  return {
    position: "absolute",
    top: hasWindowChrome ? `${WINDOW_CHROME_HEIGHT}px` : "0",
    left: "0",
    right: "0",
    height: visible ? "30px" : "8px",
    "z-index": "110",
    overflow: "visible",
  };
}
