// 顶部 tab 栏:每个 tab 一个按钮(active 高亮 + × 关闭),尾部 + 新建。
//
// label 取 `workspace.tabTitle`(focused leaf 的 OSC 标题,fallback "shell");
// 标题与 activeTab 都是 store-backed,JSX 内读取即响应式跟随。

import { type Component, For } from "solid-js";

import type { Workspace } from "../state/workspace";

export type TabBarProps = { workspace: Workspace };

export const TabBar: Component<TabBarProps> = (props) => {
  const ws = props.workspace;
  return (
    <div style={barStyle}>
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
    </div>
  );
};

const barStyle: Record<string, string> = {
  display: "flex",
  "flex-shrink": "0",
  height: "30px",
  background: "#252526",
  "border-bottom": "1px solid #1a1a1a",
  "font-family": "ui-monospace, monospace",
  "font-size": "12px",
  "user-select": "none",
};

const tabStyle = (active: boolean): Record<string, string> => ({
  display: "flex",
  "align-items": "center",
  gap: "6px",
  padding: "0 10px",
  "max-width": "200px",
  background: active ? "#1e1e1e" : "#2d2d2d",
  color: active ? "#ffffff" : "#969696",
  "border-right": "1px solid #1a1a1a",
  cursor: "pointer",
});

const labelStyle: Record<string, string> = {
  overflow: "hidden",
  "text-overflow": "ellipsis",
  "white-space": "nowrap",
};

const closeStyle: Record<string, string> = {
  color: "#888",
  "font-size": "14px",
  "line-height": "1",
  padding: "0 2px",
};

const newTabStyle: Record<string, string> = {
  display: "flex",
  "align-items": "center",
  padding: "0 12px",
  color: "#969696",
  cursor: "pointer",
  "font-size": "16px",
};
