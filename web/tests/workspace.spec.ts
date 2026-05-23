// workspace 生命周期单测。
//
// `createWorkspace` 的 tab / pane 操作不调 `LeafSession.connect()`(只有
// `PaneLeaf` 挂载时才连),所以这层在 jsdom 下可直接测,无需 fake socket ──
// 树编辑委派给已测的 `pane_tree`,本文件专测「树编辑 + session 生命周期」的
// 配对:创建 / 销毁、空 tabs 状态、activeTab clamp、焦点路由。
//
// session 是否被销毁,用 `sessionFor` 是否抛错来观察(注册表项已删)。

import { describe, expect, it } from "vitest";

import { type PaneTree, leafIds } from "../src/state/pane_tree";
import { createWorkspace } from "../src/state/workspace";

const otherLeaf = (tree: PaneTree, exclude: string): string => {
  const id = leafIds(tree).find((i) => i !== exclude);
  if (id === undefined) throw new Error("expected a second leaf");
  return id;
};

describe("createWorkspace — initial state", () => {
  it("starts empty (App layer decides default tab per platform)", () => {
    const ws = createWorkspace();
    expect(ws.state.tabs).toHaveLength(0);
    expect(ws.focusedSession()).toBeUndefined();
  });

  it("newTab populates the first tab from empty state", () => {
    const ws = createWorkspace();
    ws.newTab();
    expect(ws.state.tabs).toHaveLength(1);
    expect(ws.state.activeTab).toBe(0);
    const tab = ws.state.tabs[0];
    expect(tab.tree.kind).toBe("leaf");
    expect(leafIds(tab.tree)).toEqual([tab.focusedLeaf]);
    expect(ws.focusedSession()?.id).toBe(tab.focusedLeaf);
  });
});

describe("tab lifecycle", () => {
  it("newTab adds tabs and activates the new one", () => {
    const ws = createWorkspace();
    ws.newTab();
    ws.newTab();
    expect(ws.state.tabs).toHaveLength(2);
    expect(ws.state.activeTab).toBe(1);
  });

  it("closeTab on a non-last tab removes it and clamps activeTab", () => {
    const ws = createWorkspace();
    ws.newTab();
    ws.newTab();
    ws.newTab(); // 3 tabs, active = 2
    const midId = ws.state.tabs[1].id;
    ws.closeTab(midId);
    expect(ws.state.tabs).toHaveLength(2);
    expect(ws.state.tabs.find((t) => t.id === midId)).toBeUndefined();
    expect(ws.state.activeTab).toBeLessThan(ws.state.tabs.length);
  });

  it("closeTab on the only tab leaves an empty workspace (no respawn)", () => {
    const ws = createWorkspace();
    ws.newTab();
    const oldTabId = ws.state.tabs[0].id;
    const oldLeaf = ws.state.tabs[0].focusedLeaf;
    ws.closeTab(oldTabId);
    expect(ws.state.tabs).toHaveLength(0);
    expect(ws.focusedSession()).toBeUndefined();
    expect(() => ws.sessionFor(oldLeaf)).toThrow();
  });

  it("switchTab clamps out-of-range indices when tabs exist", () => {
    const ws = createWorkspace();
    ws.newTab();
    ws.newTab();
    ws.switchTab(99);
    expect(ws.state.activeTab).toBe(1);
    ws.switchTab(-5);
    expect(ws.state.activeTab).toBe(0);
  });

  it("switchTab is a no-op when tabs is empty", () => {
    const ws = createWorkspace();
    ws.switchTab(3);
    expect(ws.state.tabs).toHaveLength(0);
  });

  it("nextTab wraps around when tabs exist", () => {
    const ws = createWorkspace();
    ws.newTab();
    ws.newTab(); // 2 tabs, active = 1
    ws.nextTab();
    expect(ws.state.activeTab).toBe(0);
    ws.nextTab();
    expect(ws.state.activeTab).toBe(1);
  });

  it("nextTab is a no-op when tabs is empty (no division by zero)", () => {
    const ws = createWorkspace();
    expect(() => ws.nextTab()).not.toThrow();
    expect(ws.state.tabs).toHaveLength(0);
  });
});

describe("pane lifecycle", () => {
  it("splitFocused splits the tree, focus moves to the new leaf", () => {
    const ws = createWorkspace();
    ws.newTab();
    const before = ws.state.tabs[0].focusedLeaf;
    ws.splitFocused("vertical");
    const tab = ws.state.tabs[0];
    expect(tab.tree.kind).toBe("split");
    const ids = leafIds(tab.tree);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(before);
    expect(tab.focusedLeaf).not.toBe(before);
    // 两个 leaf 都有 session。
    for (const id of ids) expect(ws.sessionFor(id).id).toBe(id);
  });

  it("splitFocused is a no-op when tabs is empty", () => {
    const ws = createWorkspace();
    expect(() => ws.splitFocused("vertical")).not.toThrow();
    expect(ws.state.tabs).toHaveLength(0);
  });

  it("closeFocused with >1 leaf collapses the split and disposes the closed session", () => {
    const ws = createWorkspace();
    ws.newTab();
    ws.splitFocused("vertical");
    const closed = ws.state.tabs[0].focusedLeaf;
    const sibling = otherLeaf(ws.state.tabs[0].tree, closed);
    ws.closeFocused();
    const tab = ws.state.tabs[0];
    expect(tab.tree).toEqual({ kind: "leaf", id: sibling });
    expect(tab.focusedLeaf).toBe(sibling);
    expect(() => ws.sessionFor(closed)).toThrow(); // 已销毁
    expect(ws.sessionFor(sibling).id).toBe(sibling);
  });

  it("closeFocused on a lone pane of a non-last tab closes the whole tab", () => {
    const ws = createWorkspace();
    ws.newTab();
    ws.newTab(); // 2 tabs, active = 1
    const leaf = ws.state.tabs[1].focusedLeaf;
    ws.closeFocused();
    expect(ws.state.tabs).toHaveLength(1);
    expect(() => ws.sessionFor(leaf)).toThrow();
  });

  it("closeFocused on the last lone pane leaves an empty workspace", () => {
    const ws = createWorkspace();
    ws.newTab();
    const oldLeaf = ws.state.tabs[0].focusedLeaf;
    ws.closeFocused();
    expect(ws.state.tabs).toHaveLength(0);
    expect(() => ws.sessionFor(oldLeaf)).toThrow();
    expect(ws.focusedSession()).toBeUndefined();
  });
});

describe("focus", () => {
  it("focusLeaf moves focus and focusedSession follows it", () => {
    const ws = createWorkspace();
    ws.newTab();
    ws.splitFocused("vertical");
    const focused = ws.state.tabs[0].focusedLeaf;
    const other = otherLeaf(ws.state.tabs[0].tree, focused);
    expect(ws.focusedSession()?.id).toBe(focused);
    ws.focusLeaf(other);
    expect(ws.state.tabs[0].focusedLeaf).toBe(other);
    expect(ws.focusedSession()?.id).toBe(other);
  });

  it("focusNeighbor moves focus spatially", () => {
    const ws = createWorkspace();
    ws.newTab();
    ws.splitFocused("vertical"); // a | b,焦点在 b(右)
    const focused = ws.state.tabs[0].focusedLeaf;
    ws.focusNeighbor("left");
    expect(ws.state.tabs[0].focusedLeaf).not.toBe(focused);
    ws.focusNeighbor("right");
    expect(ws.state.tabs[0].focusedLeaf).toBe(focused);
  });
});

describe("setRatio", () => {
  it("updates the split ratio, clamped", () => {
    const ws = createWorkspace();
    ws.newTab();
    ws.splitFocused("vertical");
    const tabId = ws.state.tabs[0].id;

    ws.setRatio(tabId, [], 0.75);
    const t1 = ws.state.tabs[0].tree;
    if (t1.kind !== "split") throw new Error("expected split");
    expect(t1.ratio).toBe(0.75);

    ws.setRatio(tabId, [], 5);
    const t2 = ws.state.tabs[0].tree;
    if (t2.kind !== "split") throw new Error("expected split");
    expect(t2.ratio).toBe(0.9);
  });
});
