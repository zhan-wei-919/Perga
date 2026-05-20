// Pane 布局的纯数据模型:一棵二叉分屏树 + 纯变换。
//
// 这一层只认 leaf **id**,不碰 Solid、不碰 DOM、不碰 session。真正的
// `SessionSocket` / `SessionStore` 由 `workspace.ts` 按 leaf id 索引持有。
// 树是值,session 是资源,靠 id 关联 ── 所以这整个文件 100% 纯函数可单测。
//
// 所有变换返回**新树**,绝不 mutate;未改动的子树保持引用不变(结构共享)。

/** 一个 pane leaf 的 id。不透明字符串,由 `workspace.ts` 铸造,本层不解析。 */
export type LeafId = string;

/**
 * Split 朝向。
 * - "vertical":分隔线竖直 → 两个子节点左右并排(left | right)。
 * - "horizontal":分隔线水平 → 两个子节点上下堆叠(top / bottom)。
 */
export type SplitAxis = "vertical" | "horizontal";

export type PaneTree =
  | { kind: "leaf"; id: LeafId }
  | {
      kind: "split";
      axis: SplitAxis;
      /** 分给子 `a` 的比例。范围 [0.1, 0.9],由 `clampRatio` 保证。 */
      ratio: number;
      a: PaneTree;
      b: PaneTree;
    };

/** 从 root 到某个 split 节点的路径,每步选子 "a" 或 "b"。空路径 = root 自身。 */
export type SplitPath = ReadonlyArray<"a" | "b">;

/** 一次树变换的结果:新树 + 变换后的焦点 leaf。 */
export type TreeEdit = { tree: PaneTree; focus: LeafId };

// gutter 拖到极端会让一侧 pane 收成 0 ── 留 10% 下限保证两侧都还能用。
const MIN_RATIO = 0.1;
const MAX_RATIO = 0.9;

/** 把 ratio 钳进可拖拽范围。gutter 拖拽和 `splitFocused` 共用同一定义。 */
export function clampRatio(r: number): number {
  if (r < MIN_RATIO) return MIN_RATIO;
  if (r > MAX_RATIO) return MAX_RATIO;
  return r;
}

/** 造一棵单 leaf 树。新树的唯一构造入口。 */
export function leafTree(id: LeafId): PaneTree {
  return { kind: "leaf", id };
}

// ── 读取(纯) ──────────────────────────────────────────────────────────

/** 左→右深度优先的 leaf id 列表;顺序 = 视觉顺序(a 在 b 前)。 */
export function leafIds(t: PaneTree): LeafId[] {
  return t.kind === "leaf" ? [t.id] : [...leafIds(t.a), ...leafIds(t.b)];
}

/** 最左 / 最上的 leaf id。变换后的焦点 fallback 用。 */
export function firstLeafId(t: PaneTree): LeafId {
  let node = t;
  while (node.kind === "split") node = node.a;
  return node.id;
}

/** `id` 是否存在于树中。 */
export function hasLeaf(t: PaneTree, id: LeafId): boolean {
  return t.kind === "leaf"
    ? t.id === id
    : hasLeaf(t.a, id) || hasLeaf(t.b, id);
}

/** leaf 数量。 */
export function leafCount(t: PaneTree): number {
  return t.kind === "leaf" ? 1 : leafCount(t.a) + leafCount(t.b);
}

// ── 变换(纯,返回新树) ────────────────────────────────────────────────

/**
 * 把 focused leaf 一分为二:focused 成为子 `a`,新 leaf(`newId`)成为子 `b`,
 * ratio = 0.5。焦点**移到新 leaf**(对齐 tmux / iTerm:新 pane 是开始打字的地方)。
 * `newId` 由调用方(workspace)铸造,树保持纯。
 */
export function splitFocused(
  t: PaneTree,
  focused: LeafId,
  axis: SplitAxis,
  newId: LeafId,
): TreeEdit {
  const tree = replaceLeaf(t, focused, (leaf) => ({
    kind: "split",
    axis,
    ratio: 0.5,
    a: leaf,
    b: leafTree(newId),
  }));
  return { tree, focus: newId };
}

/**
 * 移除 focused leaf:它的兄弟子树替换父 split(split 塌缩)。焦点落到被提升的
 * 兄弟子树的 first leaf。
 *
 * 前置条件:`leafCount(t) > 1` 且 `focused` 存在。单 leaf 树不能由本函数关闭
 * ── 那是「关 tab / respawn」的范畴,由 workspace 判定(数据模型优先:本层
 * 永不产生空树)。违反前置条件直接抛错,fail loud。
 */
export function closeFocused(t: PaneTree, focused: LeafId): TreeEdit {
  const result = removeLeaf(t, focused);
  if (!result) {
    throw new Error(
      `closeFocused: ${focused} 不可关闭(leafCount 必须 > 1 且 leaf 存在)`,
    );
  }
  return { tree: result.tree, focus: firstLeafId(result.promoted) };
}

/**
 * 设定 `path` 指向的 split 节点的 ratio(已 clamp)。gutter 拖拽用。
 * 按路径定位而非按 leaf id ── 一个 gutter 唯一对应一个 split 节点。
 */
export function setRatio(t: PaneTree, path: SplitPath, ratio: number): PaneTree {
  return setRatioAt(t, path, 0, clampRatio(ratio));
}

/**
 * 把焦点移到 `dir` 方向的空间相邻 pane。返回相邻 leaf id;该方向无相邻 pane 时
 * 返回 `focused` 本身(边界处不环绕,对齐 tmux 默认)。
 */
export function focusNeighbor(
  t: PaneTree,
  focused: LeafId,
  dir: "up" | "down" | "left" | "right",
): LeafId {
  const rects = layoutLeaves(t);
  const src = rects.get(focused);
  if (!src) return focused;

  let best: LeafId | null = null;
  let bestScore: NeighborScore | null = null;
  for (const [id, c] of rects) {
    if (id === focused) continue;
    const score = scoreNeighbor(src, c, dir);
    if (score && isBetterNeighbor(score, bestScore)) {
      best = id;
      bestScore = score;
    }
  }
  return best ?? focused;
}

// ── 私有 helper ────────────────────────────────────────────────────────

type LeafNode = Extract<PaneTree, { kind: "leaf" }>;

/** 把 `id` 对应的 leaf 替换成 `fn(leaf)`;未命中的子树保持引用不变。 */
function replaceLeaf(
  t: PaneTree,
  id: LeafId,
  fn: (leaf: LeafNode) => PaneTree,
): PaneTree {
  if (t.kind === "leaf") return t.id === id ? fn(t) : t;
  const a = replaceLeaf(t.a, id, fn);
  const b = replaceLeaf(t.b, id, fn);
  // 两子树都没变 → 返回原节点,结构共享。
  return a === t.a && b === t.b ? t : { ...t, a, b };
}

/**
 * 从树中摘掉 `id` 对应的 leaf。返回 `{ tree, promoted }`:`tree` 是新树,
 * `promoted` 是替换掉父 split 的那棵兄弟子树(焦点落点的依据)。摘不掉(单
 * leaf 树 / id 不存在)返回 null。
 */
function removeLeaf(
  t: PaneTree,
  id: LeafId,
): { tree: PaneTree; promoted: PaneTree } | null {
  if (t.kind === "leaf") return null;
  // 直接子节点就是目标 leaf → 用兄弟替换本 split。
  if (t.a.kind === "leaf" && t.a.id === id) {
    return { tree: t.b, promoted: t.b };
  }
  if (t.b.kind === "leaf" && t.b.id === id) {
    return { tree: t.a, promoted: t.a };
  }
  // 递归。promoted 一路原样上传 ── 它属于真正发生塌缩的那个 split。
  const inA = removeLeaf(t.a, id);
  if (inA) return { tree: { ...t, a: inA.tree }, promoted: inA.promoted };
  const inB = removeLeaf(t.b, id);
  if (inB) return { tree: { ...t, b: inB.tree }, promoted: inB.promoted };
  return null;
}

function setRatioAt(
  t: PaneTree,
  path: SplitPath,
  depth: number,
  ratio: number,
): PaneTree {
  if (t.kind !== "split") {
    throw new Error("setRatio: 路径未指向 split 节点");
  }
  if (depth === path.length) return { ...t, ratio };
  return path[depth] === "a"
    ? { ...t, a: setRatioAt(t.a, path, depth + 1, ratio) }
    : { ...t, b: setRatioAt(t.b, path, depth + 1, ratio) };
}

// ── focusNeighbor 的空间布局 ──────────────────────────────────────────
//
// 树本身不存坐标。给每个 leaf 在归一化的 [0,1]×[0,1] 空间里算一个矩形,
// Alt+Arrow 就退化成「在矩形集合里挑相邻者」。

type Rect = { x: number; y: number; w: number; h: number };

/** 给树里每个 leaf 算一个归一化矩形。root box = 整个 [0,1]² 空间。 */
function layoutLeaves(t: PaneTree): Map<LeafId, Rect> {
  const out = new Map<LeafId, Rect>();
  const walk = (node: PaneTree, box: Rect): void => {
    if (node.kind === "leaf") {
      out.set(node.id, box);
      return;
    }
    if (node.axis === "vertical") {
      const aw = box.w * node.ratio;
      walk(node.a, { x: box.x, y: box.y, w: aw, h: box.h });
      walk(node.b, { x: box.x + aw, y: box.y, w: box.w - aw, h: box.h });
    } else {
      const ah = box.h * node.ratio;
      walk(node.a, { x: box.x, y: box.y, w: box.w, h: ah });
      walk(node.b, { x: box.x, y: box.y + ah, w: box.w, h: box.h - ah });
    }
  };
  walk(t, { x: 0, y: 0, w: 1, h: 1 });
  return out;
}

const EPS = 1e-6;

type NeighborScore = {
  /** 与 src 在垂直于移动方向的轴上的重叠长度。越大越「正对着」。 */
  overlap: number;
  /** 移动方向上的间隙。越小越近。 */
  gap: number;
  /** 垂直轴上的起点坐标,用于最终 tie-break,保证确定性。 */
  perp: number;
};

/** 候选 `c` 作为 src 在 `dir` 方向邻居的评分;不合格返回 null。 */
function scoreNeighbor(
  src: Rect,
  c: Rect,
  dir: "up" | "down" | "left" | "right",
): NeighborScore | null {
  let qualifies: boolean;
  let overlap: number;
  let gap: number;
  let perp: number;
  if (dir === "right") {
    qualifies = c.x >= src.x + src.w - EPS;
    overlap = spanOverlap(src.y, src.h, c.y, c.h);
    gap = c.x - (src.x + src.w);
    perp = c.y;
  } else if (dir === "left") {
    qualifies = c.x + c.w <= src.x + EPS;
    overlap = spanOverlap(src.y, src.h, c.y, c.h);
    gap = src.x - (c.x + c.w);
    perp = c.y;
  } else if (dir === "down") {
    qualifies = c.y >= src.y + src.h - EPS;
    overlap = spanOverlap(src.x, src.w, c.x, c.w);
    gap = c.y - (src.y + src.h);
    perp = c.x;
  } else {
    qualifies = c.y + c.h <= src.y + EPS;
    overlap = spanOverlap(src.x, src.w, c.x, c.w);
    gap = src.y - (c.y + c.h);
    perp = c.x;
  }
  // 垂直轴必须有重叠,否则是对角而非相邻。
  if (!qualifies || overlap <= EPS) return null;
  return { overlap, gap, perp };
}

/** cand 是否比当前 best 更好:重叠大 > 间隙小 > perp 小。 */
function isBetterNeighbor(
  cand: NeighborScore,
  best: NeighborScore | null,
): boolean {
  if (!best) return true;
  if (Math.abs(cand.overlap - best.overlap) > EPS) {
    return cand.overlap > best.overlap;
  }
  if (Math.abs(cand.gap - best.gap) > EPS) return cand.gap < best.gap;
  return cand.perp < best.perp;
}

/** 一维区间 [a0,a0+aLen] 与 [b0,b0+bLen] 的重叠长度(可能为负 = 不相交)。 */
function spanOverlap(
  a0: number,
  aLen: number,
  b0: number,
  bLen: number,
): number {
  return Math.min(a0 + aLen, b0 + bLen) - Math.max(a0, b0);
}
