// session 状态层单测:
// - expandRowEntries:RLE 三种 entry 的纯解码逻辑。
// - createSessionStore:协议事件 → store 的真实生产路径
//   (Init/Patch/Exited/CommandBlock)。createStore 在 jsdom 下能正常跑。

import { describe, expect, it } from "vitest";

import { blankCell, expandRowEntries } from "../src/state/session";
import { createSessionStore } from "../src/state/session_store";

describe("expandRowEntries", () => {
  it("blank fills with default cells", () => {
    const cells = expandRowEntries([{ type: "blank", count: 5 }], 5);
    expect(cells).toHaveLength(5);
    expect(cells[0]).toEqual(blankCell());
  });

  it("text uses default fg/bg when omitted", () => {
    const cells = expandRowEntries([{ type: "text", s: "abc" }], 3);
    expect(cells.map((c) => c.ch)).toEqual(["a", "b", "c"]);
    expect(cells[0].fg).toEqual({ named: "foreground" });
    expect(cells[0].bg).toEqual({ named: "background" });
    expect(cells[0].attrs).toEqual([]);
  });

  it("text honors explicit color and attrs", () => {
    const cells = expandRowEntries(
      [
        {
          type: "text",
          s: "X",
          fg: { rgb: { r: 255, g: 0, b: 0 } },
          attrs: ["bold"],
        },
      ],
      1,
    );
    expect(cells[0].fg).toEqual({ rgb: { r: 255, g: 0, b: 0 } });
    expect(cells[0].attrs).toEqual(["bold"]);
  });

  it("mixed entries assemble in order", () => {
    const cells = expandRowEntries(
      [
        { type: "text", s: "hi" },
        { type: "blank", count: 2 },
        { type: "text", s: "x" },
      ],
      5,
    );
    expect(cells.map((c) => c.ch)).toEqual(["h", "i", " ", " ", "x"]);
  });

  it("pads short rows with blanks (protocol violation fallback)", () => {
    const cells = expandRowEntries([{ type: "text", s: "ab" }], 5);
    expect(cells).toHaveLength(5);
    expect(cells[2].ch).toBe(" ");
  });

  it("truncates overlong rows", () => {
    const cells = expandRowEntries([{ type: "text", s: "abcdef" }], 3);
    expect(cells).toHaveLength(3);
    expect(cells.map((c) => c.ch)).toEqual(["a", "b", "c"]);
  });

  it("cells variant passes through verbatim (wide / combining)", () => {
    const wide = {
      ch: "中",
      combining: [],
      width: "wide" as const,
      fg: { named: "foreground" as const },
      bg: { named: "background" as const },
      attrs: [],
    };
    const cells = expandRowEntries([{ type: "cells", cells: [wide] }], 1);
    expect(cells[0]).toBe(wide);
  });
});

describe("createSessionStore", () => {
  it("keeps raw grid outside Solid view state across init", () => {
    const store = createSessionStore({ rows: 2, cols: 3 });
    const gridRef = store.grid;

    store.dispatch({
      type: "init",
      seq: 1,
      size: { rows: 2, cols: 3 },
      cursor: { row: 0, col: 0, visible: true, style: "block" },
      rows: [
        [{ type: "text", s: "abc" }],
        [{ type: "text", s: "xyz" }],
      ],
      modes: store.state.modes,
      title: "shell",
      active_top: 0,
    });

    expect(store.grid).toBe(gridRef);
    expect((store.state as unknown as { grid?: unknown }).grid).toBeUndefined();
    expect(store.grid[0].map((c) => c.ch)).toEqual(["a", "b", "c"]);
    expect(store.grid[1].map((c) => c.ch)).toEqual(["x", "y", "z"]);
    expect(store.state.rowGen).toEqual([1, 1]);
    expect(store.state.title).toBe("shell");
  });

  it("patch mutates raw dirty rows and bumps only their rowGen", () => {
    const store = createSessionStore({ rows: 3, cols: 2 });
    store.dispatch({
      type: "init",
      seq: 1,
      size: { rows: 3, cols: 2 },
      cursor: { row: 0, col: 0, visible: true, style: "block" },
      rows: [
        [{ type: "text", s: "aa" }],
        [{ type: "text", s: "bb" }],
        [{ type: "text", s: "cc" }],
      ],
      modes: store.state.modes,
      title: null,
      active_top: 0,
    });

    const gridRef = store.grid;
    const row0 = store.grid[0];
    const row1 = store.grid[1];
    const row2 = store.grid[2];
    const baselineGen = store.state.rowGen.slice();

    store.dispatch({
      type: "patch",
      seq: 2,
      cursor: { row: 1, col: 0, visible: true, style: "block" },
      dirty_rows: [{ index: 1, entries: [{ type: "text", s: "xy" }] }],
      active_top: 0,
    });

    expect(store.grid).toBe(gridRef);
    expect(store.grid[0]).toBe(row0);
    expect(store.grid[1]).not.toBe(row1);
    expect(store.grid[2]).toBe(row2);
    expect(store.grid[1].map((c) => c.ch)).toEqual(["x", "y"]);
    expect(store.state.cursor).toEqual({
      row: 1,
      col: 0,
      visible: true,
      style: "block",
    });
    expect(store.state.rowGen[0]).toBe(baselineGen[0]);
    expect(store.state.rowGen[1]).toBe(baselineGen[1] + 1);
    expect(store.state.rowGen[2]).toBe(baselineGen[2]);
  });

  it("patch title set/reset both round-trip", () => {
    const store = createSessionStore({ rows: 1, cols: 1 });
    store.dispatch({
      type: "init",
      seq: 1,
      size: { rows: 1, cols: 1 },
      cursor: { row: 0, col: 0, visible: true, style: "block" },
      rows: [[{ type: "blank", count: 1 }]],
      modes: store.state.modes,
      title: null,
      active_top: 0,
    });
    expect(store.state.title).toBeNull();

    store.dispatch({
      type: "patch",
      seq: 2,
      cursor: { row: 0, col: 0, visible: true, style: "block" },
      dirty_rows: [],
      active_top: 0,
      title: { kind: "set", value: "hello" },
    });
    expect(store.state.title).toBe("hello");

    store.dispatch({
      type: "patch",
      seq: 3,
      cursor: { row: 0, col: 0, visible: true, style: "block" },
      dirty_rows: [],
      active_top: 0,
      title: { kind: "reset" },
    });
    expect(store.state.title).toBeNull();
  });

  it("patch skips out-of-range dirty index, applies valid ones", () => {
    const store = createSessionStore({ rows: 2, cols: 1 });
    store.dispatch({
      type: "init",
      seq: 1,
      size: { rows: 2, cols: 1 },
      cursor: { row: 0, col: 0, visible: true, style: "block" },
      rows: [[{ type: "blank", count: 1 }], [{ type: "blank", count: 1 }]],
      modes: store.state.modes,
      title: null,
      active_top: 0,
    });

    store.dispatch({
      type: "patch",
      seq: 2,
      cursor: { row: 0, col: 0, visible: true, style: "block" },
      dirty_rows: [
        { index: 99, entries: [{ type: "text", s: "x" }] },
        { index: 0, entries: [{ type: "text", s: "y" }] },
      ],
      active_top: 0,
    });

    expect(store.grid[0][0].ch).toBe("y");
  });

  it("exited sets flag and updates seq", () => {
    const store = createSessionStore({ rows: 1, cols: 1 });
    store.dispatch({
      type: "exited",
      seq: 42,
      status: { code: 0, signal: null },
    });
    expect(store.state.exited).toBe(true);
    expect(store.state.seq).toBe(42);
  });
});

describe("command blocks + activeTop", () => {
  /// 起一个已 init 过的 store。
  function initedStore(rows: number, cols: number) {
    const store = createSessionStore({ rows, cols });
    store.dispatch({
      type: "init",
      seq: 1,
      size: { rows, cols },
      cursor: { row: 0, col: 0, visible: true, style: "block" },
      rows: Array.from({ length: rows }, () => [
        { type: "blank" as const, count: cols },
      ]),
      modes: store.state.modes,
      title: null,
      active_top: 0,
    });
    return store;
  }

  it("command_block appends a decoded block", () => {
    const store = initedStore(4, 10);
    store.dispatch({
      type: "command_block",
      seq: 7,
      exit: 0,
      command: [[{ type: "text", s: "$ ls" }]],
      output: [[{ type: "text", s: "a" }], [{ type: "text", s: "b" }]],
    });

    expect(store.state.blocks).toHaveLength(1);
    const blk = store.state.blocks[0];
    expect(blk.id).toBe(7);
    expect(blk.exit).toBe(0);
    expect(blk.folded).toBe(false);
    expect(blk.command[0].map((c) => c.ch).join("")).toBe("$ ls");
    expect(blk.output).toHaveLength(2);
    expect(blk.output[0][0].ch).toBe("a");
    expect(blk.output[1][0].ch).toBe("b");
  });

  it("command_block rows keep their own captured width (no reflow)", () => {
    const store = initedStore(4, 10);
    // 命令行 5 列、输出行 3 列 —— 各保持自己的宽度,不对齐到 cols=10。
    store.dispatch({
      type: "command_block",
      seq: 2,
      exit: null,
      command: [[{ type: "text", s: "abcde" }]],
      output: [[{ type: "text", s: "xyz" }]],
    });
    const blk = store.state.blocks[0];
    expect(blk.command[0]).toHaveLength(5);
    expect(blk.output[0]).toHaveLength(3);
  });

  it("activeTop updates from init and patch", () => {
    const store = initedStore(6, 4);
    expect(store.state.activeTop).toBe(0);
    store.dispatch({
      type: "patch",
      seq: 2,
      cursor: { row: 0, col: 0, visible: true, style: "block" },
      dirty_rows: [],
      active_top: 3,
    });
    expect(store.state.activeTop).toBe(3);
  });

  it("blocks survive a resize-triggered init", () => {
    const store = initedStore(4, 10);
    store.dispatch({
      type: "command_block",
      seq: 2,
      exit: 0,
      command: [[{ type: "text", s: "$ x" }]],
      output: [],
    });
    expect(store.state.blocks).toHaveLength(1);

    // resize → encoder 发一条新 size 的 Init。block 是冻结历史,必须保留。
    store.dispatch({
      type: "init",
      seq: 3,
      size: { rows: 6, cols: 12 },
      cursor: { row: 0, col: 0, visible: true, style: "block" },
      rows: Array.from({ length: 6 }, () => [
        { type: "blank" as const, count: 12 },
      ]),
      modes: store.state.modes,
      title: null,
      active_top: 0,
    });
    expect(store.state.blocks).toHaveLength(1);
  });
});
