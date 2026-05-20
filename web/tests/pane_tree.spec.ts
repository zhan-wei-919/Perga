// pane_tree 纯树模型单测。无 Solid / 无 DOM,确定性。
//
// 重点覆盖:结构共享(变换不动无关子树)、closeFocused 的焦点落点、
// focusNeighbor 的空间判定、以及所有变换的不可变性。

import { describe, expect, it } from "vitest";

import {
  type PaneTree,
  clampRatio,
  closeFocused,
  firstLeafId,
  focusNeighbor,
  hasLeaf,
  leafCount,
  leafIds,
  leafTree,
  setRatio,
  splitFocused,
} from "../src/state/pane_tree";

// 简洁构造器。
const leaf = (id: string): PaneTree => ({ kind: "leaf", id });
const vsplit = (ratio: number, a: PaneTree, b: PaneTree): PaneTree => ({
  kind: "split",
  axis: "vertical",
  ratio,
  a,
  b,
});
const hsplit = (ratio: number, a: PaneTree, b: PaneTree): PaneTree => ({
  kind: "split",
  axis: "horizontal",
  ratio,
  a,
  b,
});

const clone = (t: PaneTree): PaneTree => JSON.parse(JSON.stringify(t));

describe("construction", () => {
  it("leafTree builds a lone leaf", () => {
    expect(leafTree("a")).toEqual({ kind: "leaf", id: "a" });
  });

  it("clampRatio clamps to [0.1, 0.9]", () => {
    expect(clampRatio(-1)).toBe(0.1);
    expect(clampRatio(0)).toBe(0.1);
    expect(clampRatio(1.5)).toBe(0.9);
    expect(clampRatio(0.5)).toBe(0.5);
  });
});

describe("read helpers", () => {
  // a 在左,右侧再竖切成 b(上)/ c(下)。
  const tree = vsplit(0.5, leaf("a"), hsplit(0.5, leaf("b"), leaf("c")));

  it("leafIds gives left-to-right depth-first order", () => {
    expect(leafIds(leaf("solo"))).toEqual(["solo"]);
    expect(leafIds(tree)).toEqual(["a", "b", "c"]);
  });

  it("firstLeafId is the leftmost/topmost leaf", () => {
    expect(firstLeafId(tree)).toBe("a");
    expect(firstLeafId(leaf("x"))).toBe("x");
  });

  it("hasLeaf finds present / absent leaves", () => {
    expect(hasLeaf(tree, "b")).toBe(true);
    expect(hasLeaf(tree, "zzz")).toBe(false);
  });

  it("leafCount counts leaves", () => {
    expect(leafCount(leaf("x"))).toBe(1);
    expect(leafCount(tree)).toBe(3);
  });
});

describe("splitFocused", () => {
  it("splits a lone leaf, focus moves to the new leaf", () => {
    const { tree, focus } = splitFocused(leaf("a"), "a", "vertical", "b");
    expect(tree).toEqual(vsplit(0.5, leaf("a"), leaf("b")));
    expect(focus).toBe("b");
  });

  it("horizontal axis produces a horizontal split", () => {
    const { tree } = splitFocused(leaf("a"), "a", "horizontal", "b");
    expect(tree).toEqual(hsplit(0.5, leaf("a"), leaf("b")));
  });

  it("splitting a deep leaf leaves sibling subtrees by reference", () => {
    const x = leaf("x");
    const y = leaf("y");
    const z = leaf("z");
    const t = vsplit(0.5, x, hsplit(0.5, y, z));

    const { tree, focus } = splitFocused(t, "y", "vertical", "n");
    expect(focus).toBe("n");
    if (tree.kind !== "split" || tree.b.kind !== "split") {
      throw new Error("expected nested split");
    }
    // 无关子树引用不变。
    expect(tree.a).toBe(x);
    expect(tree.b.b).toBe(z);
    // 命中的 leaf 被替换成新 split。
    expect(tree.b.a).toEqual(vsplit(0.5, leaf("y"), leaf("n")));
  });

  it("does not mutate the input tree", () => {
    const t = vsplit(0.5, leaf("a"), leaf("b"));
    const snapshot = clone(t);
    splitFocused(t, "a", "vertical", "n");
    expect(t).toEqual(snapshot);
  });
});

describe("closeFocused", () => {
  it("collapses a 2-leaf split to the sibling leaf", () => {
    const { tree, focus } = closeFocused(vsplit(0.5, leaf("a"), leaf("b")), "a");
    expect(tree).toEqual(leaf("b"));
    expect(focus).toBe("b");
  });

  it("promotes the sibling subtree, focus lands on its first leaf", () => {
    // split(v, A, split(h, B, C)) ── 关掉 B,兄弟 C 提升,焦点 = C。
    const t = vsplit(0.5, leaf("a"), hsplit(0.5, leaf("b"), leaf("c")));
    const { tree, focus } = closeFocused(t, "b");
    expect(tree).toEqual(vsplit(0.5, leaf("a"), leaf("c")));
    expect(focus).toBe("c");
  });

  it("focus is the first leaf of a multi-leaf promoted subtree", () => {
    // split(v, A, split(h, B, C)) ── 关掉 A,兄弟子树 split(h,B,C) 提升。
    const t = vsplit(0.5, leaf("a"), hsplit(0.5, leaf("b"), leaf("c")));
    const { tree, focus } = closeFocused(t, "a");
    expect(tree).toEqual(hsplit(0.5, leaf("b"), leaf("c")));
    expect(focus).toBe("b");
  });

  it("throws on a lone-leaf tree (workspace handles respawn, not the tree)", () => {
    expect(() => closeFocused(leaf("a"), "a")).toThrow();
  });

  it("does not mutate the input tree", () => {
    const t = vsplit(0.5, leaf("a"), hsplit(0.5, leaf("b"), leaf("c")));
    const snapshot = clone(t);
    closeFocused(t, "b");
    expect(t).toEqual(snapshot);
  });
});

describe("setRatio", () => {
  it("sets the root split ratio with empty path", () => {
    const tree = setRatio(vsplit(0.5, leaf("a"), leaf("b")), [], 0.7);
    if (tree.kind !== "split") throw new Error("expected split");
    expect(tree.ratio).toBe(0.7);
  });

  it("sets a nested split ratio, leaving others intact", () => {
    const z = leaf("z");
    const t = vsplit(0.5, hsplit(0.5, leaf("x"), leaf("y")), z);
    const tree = setRatio(t, ["a"], 0.3);
    if (tree.kind !== "split" || tree.a.kind !== "split") {
      throw new Error("expected nested split");
    }
    expect(tree.a.ratio).toBe(0.3);
    expect(tree.ratio).toBe(0.5);
    expect(tree.b).toBe(z);
  });

  it("clamps out-of-range ratios", () => {
    const t = vsplit(0.5, leaf("a"), leaf("b"));
    const hi = setRatio(t, [], 5);
    const lo = setRatio(t, [], -5);
    if (hi.kind !== "split" || lo.kind !== "split") {
      throw new Error("expected split");
    }
    expect(hi.ratio).toBe(0.9);
    expect(lo.ratio).toBe(0.1);
  });

  it("does not mutate the input tree", () => {
    const t = vsplit(0.5, leaf("a"), leaf("b"));
    const snapshot = clone(t);
    setRatio(t, [], 0.8);
    expect(t).toEqual(snapshot);
  });
});

describe("focusNeighbor", () => {
  it("moves across a side-by-side split, no-op vertically", () => {
    const t = vsplit(0.5, leaf("a"), leaf("b"));
    expect(focusNeighbor(t, "a", "right")).toBe("b");
    expect(focusNeighbor(t, "b", "left")).toBe("a");
    expect(focusNeighbor(t, "a", "up")).toBe("a");
    expect(focusNeighbor(t, "a", "down")).toBe("a");
  });

  it("moves across a stacked split, no-op horizontally", () => {
    const t = hsplit(0.5, leaf("a"), leaf("b"));
    expect(focusNeighbor(t, "a", "down")).toBe("b");
    expect(focusNeighbor(t, "b", "up")).toBe("a");
    expect(focusNeighbor(t, "a", "left")).toBe("a");
    expect(focusNeighbor(t, "a", "right")).toBe("a");
  });

  it("resolves neighbors in a 3-pane layout", () => {
    // a 占左半全高;右半上 b、下 c。
    const t = vsplit(0.5, leaf("a"), hsplit(0.5, leaf("b"), leaf("c")));
    // a 向右:b 和 c 都贴边,tie-break 取最上 → b。
    expect(focusNeighbor(t, "a", "right")).toBe("b");
    expect(focusNeighbor(t, "b", "left")).toBe("a");
    expect(focusNeighbor(t, "c", "left")).toBe("a");
    expect(focusNeighbor(t, "b", "down")).toBe("c");
    expect(focusNeighbor(t, "c", "up")).toBe("b");
  });

  it("returns focused unchanged when there is no neighbor", () => {
    const t = vsplit(0.5, leaf("a"), leaf("b"));
    expect(focusNeighbor(t, "b", "right")).toBe("b");
  });

  it("is deterministic", () => {
    const t = vsplit(0.5, leaf("a"), hsplit(0.5, leaf("b"), leaf("c")));
    const first = focusNeighbor(t, "a", "right");
    expect(focusNeighbor(t, "a", "right")).toBe(first);
  });
});
