// 把一个 tab 的 `PaneTree` 递归渲染成嵌套 flex 布局。
//
// split 节点 → flex 容器 + 2px gutter;leaf 节点 → `PaneLeaf`。
// 树变化时 `<Switch>` 在 leaf / split 之间切换;ratio 变化只重算 flex-grow。
//
// gutter 拖拽**不引入新节流**:它只改 store 里的 ratio,DOM 重新 flex 后每个
// PaneLeaf 的 `observeContainerResize`(80ms trailing debounce)自然把 resize
// 发给各自的 WS。

import { type Component, Match, Switch } from "solid-js";

import { type PaneTree, type SplitAxis, type SplitPath, clampRatio } from "../state/pane_tree";
import type { Tab, Workspace } from "../state/workspace";
import { PaneLeaf } from "./pane_leaf";

export type PaneTreeViewProps = {
  tab: Tab;
  workspace: Workspace;
};

/// 渲染 active tab 的 pane 树。
export const PaneTreeView: Component<PaneTreeViewProps> = (props) => (
  <PaneNode
    node={props.tab.tree}
    path={[]}
    tab={props.tab}
    workspace={props.workspace}
  />
);

type NodeProps = {
  node: PaneTree;
  /** 从 root 到本节点的路径。 */
  path: SplitPath;
  tab: Tab;
  workspace: Workspace;
};

/// 一个树节点:按 kind 渲染成 leaf 或 split。
const PaneNode: Component<NodeProps> = (props) => (
  <Switch>
    <Match when={props.node.kind === "leaf" && props.node}>
      {(leaf) => (
        <PaneLeaf
          session={props.workspace.sessionFor(leaf().id)}
          focused={leaf().id === props.tab.focusedLeaf}
          onFocusRequest={() => props.workspace.focusLeaf(leaf().id)}
        />
      )}
    </Match>
    <Match when={props.node.kind === "split" && props.node}>
      {(split) => (
        <SplitView
          split={split()}
          path={props.path}
          tab={props.tab}
          workspace={props.workspace}
        />
      )}
    </Match>
  </Switch>
);

type SplitViewProps = {
  split: Extract<PaneTree, { kind: "split" }>;
  path: SplitPath;
  tab: Tab;
  workspace: Workspace;
};

/// 一个 split 节点:两个子节点的 flex 容器 + 中间 gutter。
const SplitView: Component<SplitViewProps> = (props) => {
  let boxRef: HTMLDivElement | undefined;

  const onGutterPointerDown = (e: PointerEvent): void => {
    // 阻止默认:避免拖拽时选中文本。
    e.preventDefault();
    const box = boxRef;
    if (!box) return;
    // box 是本 split 容器,拖 gutter 只改子节点 flex、不改 box 自身 ──
    // rect 拖拽期间稳定,采一次即可。
    const rect = box.getBoundingClientRect();

    const onMove = (ev: PointerEvent): void => {
      const frac =
        props.split.axis === "vertical"
          ? (ev.clientX - rect.left) / rect.width
          : (ev.clientY - rect.top) / rect.height;
      props.workspace.setRatio(props.tab.id, props.path, clampRatio(frac));
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // 挂在 window:指针拖出 2px gutter 仍能继续。
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div ref={boxRef} style={boxStyle(props.split.axis)}>
      <div style={childStyle(props.split.ratio)}>
        <PaneNode
          node={props.split.a}
          path={[...props.path, "a"]}
          tab={props.tab}
          workspace={props.workspace}
        />
      </div>
      <div
        style={gutterStyle(props.split.axis)}
        onPointerDown={onGutterPointerDown}
      />
      <div style={childStyle(1 - props.split.ratio)}>
        <PaneNode
          node={props.split.b}
          path={[...props.path, "b"]}
          tab={props.tab}
          workspace={props.workspace}
        />
      </div>
    </div>
  );
};

const boxStyle = (axis: SplitAxis): Record<string, string> => ({
  display: "flex",
  "flex-direction": axis === "vertical" ? "row" : "column",
  width: "100%",
  height: "100%",
});

// flex-grow 用 ratio / 1-ratio 作权重,flex-basis:0 让两侧严格按比例分余量。
// min-width/height:0 是 flex 子节点能收缩到内容以下的必要条件。
const childStyle = (grow: number): Record<string, string> => ({
  "flex-grow": String(grow),
  "flex-shrink": "1",
  "flex-basis": "0",
  "min-width": "0",
  "min-height": "0",
  overflow: "hidden",
});

const gutterStyle = (axis: SplitAxis): Record<string, string> => ({
  // 2px 固定宽度 ── 不做成可配置项(无真实需求,「不为未来写代码」);
  // 颜色走主题 CSS 变量。
  flex: "0 0 2px",
  background: "var(--pg-gutter)",
  cursor: axis === "vertical" ? "col-resize" : "row-resize",
  // 触屏拖 gutter 不触发滚动(平板远程是设计目标)。
  "touch-action": "none",
});
