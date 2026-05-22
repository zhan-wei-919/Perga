// 顶部 tab 栏:每个 tab 一个按钮(active 高亮 + × 关闭),尾部 + 新建、齿轮。
//
// label 取 `workspace.tabTitle`(focused leaf 的 OSC 标题,fallback "shell");
// 标题与 activeTab 都是 store-backed,JSX 内读取即响应式跟随。
//
// 自动隐藏:tab 栏是 `position:absolute` 浮层。默认隐藏(translateY 移出),
// 顶部 hover 区展开时滑下。可见性由 `App` 算好经 `visible` 传入。

import { type Component, For } from "solid-js";

import type { Workspace } from "../state/workspace";

export type TabBarProps = {
  workspace: Workspace;
  /** 点齿轮:打开设置面板。 */
  onOpenSettings: () => void;
  /** 是否可见(由 App 算:多 tab 或鼠标 hover)。 */
  visible: boolean;
};

export const TabBar: Component<TabBarProps> = (props) => {
  const ws = props.workspace;
  return (
    <div style={barStyle(props.visible)}>
      <For each={ws.state.tabs}>
        {(tab, index) => (
          <div
            style={tabStyle(index() === ws.state.activeTab)}
            onClick={() => ws.switchTab(index())}
          >
            <span style={labelStyle}>{ws.tabTitle(tab.id)}</span>
            <span
              style={closeStyle}
              onClick={(e) => {
                // 别让点 × 冒泡成「切到这个 tab」。
                e.stopPropagation();
                ws.closeTab(tab.id);
              }}
            >
              ×
            </span>
          </div>
        )}
      </For>
      <div style={newTabStyle} onClick={() => ws.newTab()} title="新建 tab">
        +
      </div>
      {/* 弹性空隙把齿轮顶到最右。 */}
      <div style={{ flex: "1" }} />
      <div
        style={gearStyle}
        onClick={() => props.onOpenSettings()}
        title="设置"
      >
        ⚙
      </div>
    </div>
  );
};

/// tab 栏是浮层:`position:absolute` 贴顶,隐藏时 translateY 移出视口。
/// z-index 100 压住 pane 区(<modal 9000 / 右键菜单 10000)。
function barStyle(visible: boolean): Record<string, string> {
  return {
    position: "absolute",
    top: "0",
    left: "0",
    right: "0",
    height: "30px",
    "z-index": "100",
    display: "flex",
    background: "var(--pg-tabbar-bg)",
    "border-bottom": "1px solid var(--pg-tabbar-border)",
    "font-family": "ui-monospace, monospace",
    "font-size": "12px",
    "user-select": "none",
    transform: visible ? "translateY(0)" : "translateY(-100%)",
    transition: "transform 0.15s ease",
  };
}

const tabStyle = (active: boolean): Record<string, string> => ({
  display: "flex",
  "align-items": "center",
  gap: "6px",
  padding: "0 10px",
  "max-width": "200px",
  background: active ? "var(--pg-tab-active-bg)" : "var(--pg-tab-inactive-bg)",
  color: active ? "var(--pg-tab-active-fg)" : "var(--pg-tab-inactive-fg)",
  "border-right": "1px solid var(--pg-tabbar-border)",
  cursor: "pointer",
});

const labelStyle: Record<string, string> = {
  overflow: "hidden",
  "text-overflow": "ellipsis",
  "white-space": "nowrap",
};

const closeStyle: Record<string, string> = {
  color: "var(--pg-fg-dim)",
  "font-size": "14px",
  "line-height": "1",
  padding: "0 2px",
};

const newTabStyle: Record<string, string> = {
  display: "flex",
  "align-items": "center",
  padding: "0 12px",
  color: "var(--pg-fg-dim)",
  cursor: "pointer",
  "font-size": "16px",
};

const gearStyle: Record<string, string> = {
  display: "flex",
  "align-items": "center",
  padding: "0 12px",
  color: "var(--pg-fg-dim)",
  cursor: "pointer",
  "font-size": "14px",
};
