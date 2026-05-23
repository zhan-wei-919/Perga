// session 状态层单测:
// - expandRowEntries:RLE 三种 entry 的纯解码逻辑。
// - createSessionStore:协议事件 → store 的真实生产路径
//   (Init/Patch/Exited/CommandEnd + history 累积)。createStore 在 jsdom 下能跑。

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

const CURSOR = { row: 0, col: 0, visible: true, style: "block" as const };

describe("createSessionStore", () => {
  it("keeps raw grid outside Solid view state across init", () => {
    const store = createSessionStore({ rows: 2, cols: 3 });
    const gridRef = store.grid;

    store.dispatch({
      type: "init",
      seq: 1,
      size: { rows: 2, cols: 3 },
      cursor: CURSOR,
      rows: [[{ type: "text", s: "abc" }], [{ type: "text", s: "xyz" }]],
      modes: store.state.modes,
      title: "shell",
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
      cursor: CURSOR,
      rows: [
        [{ type: "text", s: "aa" }],
        [{ type: "text", s: "bb" }],
        [{ type: "text", s: "cc" }],
      ],
      modes: store.state.modes,
      title: null,
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
    });

    expect(store.grid).toBe(gridRef);
    expect(store.grid[0]).toBe(row0);
    expect(store.grid[1]).not.toBe(row1);
    expect(store.grid[2]).toBe(row2);
    expect(store.grid[1].map((c) => c.ch)).toEqual(["x", "y"]);
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
      cursor: CURSOR,
      rows: [[{ type: "blank", count: 1 }]],
      modes: store.state.modes,
      title: null,
    });
    expect(store.state.title).toBeNull();

    store.dispatch({
      type: "patch",
      seq: 2,
      cursor: CURSOR,
      dirty_rows: [],
      title: { kind: "set", value: "hello" },
    });
    expect(store.state.title).toBe("hello");

    store.dispatch({
      type: "patch",
      seq: 3,
      cursor: CURSOR,
      dirty_rows: [],
      title: { kind: "reset" },
    });
    expect(store.state.title).toBeNull();
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

  it("session_error 同时置 exited + sessionError + seq", () => {
    const store = createSessionStore({ rows: 1, cols: 1 });
    // 模拟服务端 SSH 连接失败发出的 SessionError。
    store.dispatch({
      type: "session_error",
      seq: 1,
      reason: "ssh auth failed: password rejected by server",
    });
    expect(store.state.exited).toBe(true);
    expect(store.state.sessionError).toBe(
      "ssh auth failed: password rejected by server",
    );
    expect(store.state.seq).toBe(1);
  });

  it("正常路径下 sessionError 保持 null", () => {
    const store = createSessionStore({ rows: 1, cols: 1 });
    store.dispatch({
      type: "exited",
      seq: 1,
      status: { code: 0, signal: null },
    });
    expect(store.state.sessionError).toBeNull();
  });
});

describe("history accumulation + command_end", () => {
  /// 起一个已 init 过的 store(全空白 grid)。
  function initedStore(rows: number, cols: number) {
    const store = createSessionStore({ rows, cols });
    store.dispatch({
      type: "init",
      seq: 1,
      size: { rows, cols },
      cursor: CURSOR,
      rows: Array.from({ length: rows }, () => [
        { type: "blank" as const, count: cols },
      ]),
      modes: store.state.modes,
      title: null,
    });
    return store;
  }

  it("patch scrolled_rows appends to history", () => {
    const store = initedStore(4, 10);
    store.dispatch({
      type: "patch",
      seq: 2,
      cursor: CURSOR,
      dirty_rows: [],
      scrolled_rows: [[{ type: "text", s: "old line" }]],
    });
    expect(store.history.rows).toHaveLength(1);
    expect(store.history.rows[0].abs).toBe(0);
    expect(store.history.rows[0].cells.map((c) => c.ch).join("").trimEnd()).toBe(
      "old line",
    );
    expect(store.state.historyLen).toBe(1);
  });

  it("patch cleared empties history", () => {
    const store = initedStore(4, 10);
    store.dispatch({
      type: "patch",
      seq: 2,
      cursor: CURSOR,
      dirty_rows: [],
      scrolled_rows: [[{ type: "text", s: "x" }]],
    });
    expect(store.history.rows).toHaveLength(1);
    store.dispatch({
      type: "patch",
      seq: 3,
      cursor: CURSOR,
      dirty_rows: [],
      cleared: true,
    });
    expect(store.history.rows).toHaveLength(0);
    expect(store.state.historyLen).toBe(0);
  });

  it("history survives a resize-triggered init", () => {
    const store = initedStore(4, 10);
    store.dispatch({
      type: "patch",
      seq: 2,
      cursor: CURSOR,
      dirty_rows: [],
      scrolled_rows: [[{ type: "text", s: "kept" }]],
    });
    expect(store.history.rows).toHaveLength(1);

    // resize → encoder 发一条新 size 的 Init。history 是旧内容,必须保留。
    store.dispatch({
      type: "init",
      seq: 3,
      size: { rows: 6, cols: 12 },
      cursor: CURSOR,
      rows: Array.from({ length: 6 }, () => [
        { type: "blank" as const, count: 12 },
      ]),
      modes: store.state.modes,
      title: null,
    });
    expect(store.history.rows).toHaveLength(1);
  });

  it("failed command_end marks its line once it scrolls into history", () => {
    const store = initedStore(4, 10);
    // 命令在第 0 行,失败。此刻第 0 行还在活动区。
    store.dispatch({ type: "command_end", seq: 2, exit: 1, line: 0 });
    expect(store.history.failed.size).toBe(0);

    // 第 0 行滚进 history → 标记落地,failureGen 推进。
    store.dispatch({
      type: "patch",
      seq: 3,
      cursor: CURSOR,
      dirty_rows: [],
      scrolled_rows: [[{ type: "text", s: "$ false" }]],
    });
    expect(store.history.failed.has(0)).toBe(true);
    expect(store.state.failureGen).toBe(1);
  });

  it("successful command_end does not mark", () => {
    const store = initedStore(4, 10);
    store.dispatch({ type: "command_end", seq: 2, exit: 0, line: 0 });
    store.dispatch({
      type: "patch",
      seq: 3,
      cursor: CURSOR,
      dirty_rows: [],
      scrolled_rows: [[{ type: "text", s: "$ true" }]],
    });
    expect(store.history.failed.size).toBe(0);
    expect(store.state.failureGen).toBe(0);
  });
});
