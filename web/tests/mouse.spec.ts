// mouse 路由 + 坐标换算 + wheel 累加器的纯逻辑测试。
//
// 后端 `encode_mouse` 已有 Rust 单元测试覆盖 SGR/X10 编码细节;这里只验前端
// 决策层和坐标层 ── 不重复测后端责任。

import { describe, expect, it } from "vitest";
import {
  buildMouseMessage,
  collectMouseMods,
  decideMouseRouting,
  pointerButton,
  selectionPointToCell,
  wheelLineSteps,
  type MouseEventKind,
} from "../src/input/mouse";
import type { MouseReporting } from "../src/state/protocol";

describe("decideMouseRouting", () => {
  it("off mode always routes to selection", () => {
    const kinds: MouseEventKind[] = ["click", "drag", "motion"];
    for (const kind of kinds) {
      for (const shiftKey of [false, true]) {
        expect(
          decideMouseRouting({ mouseReporting: "off", kind, shiftKey }),
        ).toBe("selection");
      }
    }
  });

  it("shift always forces selection regardless of mode", () => {
    const modes: MouseReporting[] = ["off", "normal", "button", "any"];
    const kinds: MouseEventKind[] = ["click", "drag", "motion"];
    for (const mouseReporting of modes) {
      for (const kind of kinds) {
        expect(
          decideMouseRouting({ mouseReporting, kind, shiftKey: true }),
        ).toBe("selection");
      }
    }
  });

  it("normal mode: click goes to TUI, drag/motion ignored", () => {
    expect(
      decideMouseRouting({
        mouseReporting: "normal",
        kind: "click",
        shiftKey: false,
      }),
    ).toBe("tui");
    expect(
      decideMouseRouting({
        mouseReporting: "normal",
        kind: "drag",
        shiftKey: false,
      }),
    ).toBe("ignore");
    expect(
      decideMouseRouting({
        mouseReporting: "normal",
        kind: "motion",
        shiftKey: false,
      }),
    ).toBe("ignore");
  });

  it("button mode: click + drag go to TUI, motion ignored", () => {
    expect(
      decideMouseRouting({
        mouseReporting: "button",
        kind: "click",
        shiftKey: false,
      }),
    ).toBe("tui");
    expect(
      decideMouseRouting({
        mouseReporting: "button",
        kind: "drag",
        shiftKey: false,
      }),
    ).toBe("tui");
    expect(
      decideMouseRouting({
        mouseReporting: "button",
        kind: "motion",
        shiftKey: false,
      }),
    ).toBe("ignore");
  });

  it("any mode: all event kinds go to TUI", () => {
    const kinds: MouseEventKind[] = ["click", "drag", "motion"];
    for (const kind of kinds) {
      expect(
        decideMouseRouting({
          mouseReporting: "any",
          kind,
          shiftKey: false,
        }),
      ).toBe("tui");
    }
  });
});

describe("pointerButton", () => {
  it("maps 0/1/2 to left/middle/right", () => {
    expect(pointerButton(0)).toBe("left");
    expect(pointerButton(1)).toBe("middle");
    expect(pointerButton(2)).toBe("right");
  });

  it("returns null for forward / back / unknown buttons", () => {
    expect(pointerButton(3)).toBeNull();
    expect(pointerButton(4)).toBeNull();
    expect(pointerButton(-1)).toBeNull();
  });
});

describe("collectMouseMods", () => {
  it("returns undefined when no modifier is pressed", () => {
    expect(
      collectMouseMods({ ctrlKey: false, altKey: false, shiftKey: false }),
    ).toBeUndefined();
  });

  it("includes only the pressed modifiers", () => {
    expect(
      collectMouseMods({ ctrlKey: true, altKey: false, shiftKey: true }),
    ).toEqual({ ctrl: true, shift: true });
    expect(
      collectMouseMods({ ctrlKey: false, altKey: true, shiftKey: false }),
    ).toEqual({ alt: true });
  });
});

describe("selectionPointToCell", () => {
  // 非 alt-screen 布局:历史在前(行 0..historyLen-1),active grid 在后
  // (行 historyLen..historyLen+gridRows-1)。
  const baseLayout = {
    historyLen: 10,
    gridRows: 24,
    cols: 80,
    altScreen: false,
  };

  it("returns null when point is in history (non-alt screen)", () => {
    expect(
      selectionPointToCell({ row: 0, col: 5 }, baseLayout),
    ).toBeNull();
    expect(
      selectionPointToCell({ row: 9, col: 5 }, baseLayout),
    ).toBeNull();
  });

  it("converts active-grid row to 1-based terminal row", () => {
    // 第一活动行 = display row 10 → terminal row 1
    expect(selectionPointToCell({ row: 10, col: 0 }, baseLayout)).toEqual({
      row: 1,
      col: 1,
    });
    // 最后一行 = display row 33 → terminal row 24
    expect(selectionPointToCell({ row: 33, col: 0 }, baseLayout)).toEqual({
      row: 24,
      col: 1,
    });
  });

  it("returns null when point is below active grid", () => {
    expect(selectionPointToCell({ row: 34, col: 5 }, baseLayout)).toBeNull();
  });

  it("clamps col == cols (past end of row) to last column", () => {
    // col 80 = 行尾右侧选边界 → 夹到 col=80(1-based)= last col
    expect(selectionPointToCell({ row: 10, col: 80 }, baseLayout)).toEqual({
      row: 1,
      col: 80,
    });
  });

  it("alt-screen layout: history is suspended, all rows are active", () => {
    const alt = { ...baseLayout, altScreen: true };
    expect(selectionPointToCell({ row: 0, col: 5 }, alt)).toEqual({
      row: 1,
      col: 6,
    });
    expect(selectionPointToCell({ row: 23, col: 79 }, alt)).toEqual({
      row: 24,
      col: 80,
    });
    expect(selectionPointToCell({ row: 24, col: 0 }, alt)).toBeNull();
  });

  it("clampToActiveGrid: rows in history are clamped to first active row", () => {
    expect(
      selectionPointToCell({ row: 0, col: 5 }, baseLayout, {
        clampToActiveGrid: true,
      }),
    ).toEqual({ row: 1, col: 6 });
    expect(
      selectionPointToCell({ row: 9, col: 5 }, baseLayout, {
        clampToActiveGrid: true,
      }),
    ).toEqual({ row: 1, col: 6 });
  });

  it("clampToActiveGrid: rows below grid are clamped to last active row", () => {
    expect(
      selectionPointToCell({ row: 99, col: 5 }, baseLayout, {
        clampToActiveGrid: true,
      }),
    ).toEqual({ row: 24, col: 6 });
  });

  it("clampToActiveGrid: in-bounds rows are unaffected", () => {
    expect(
      selectionPointToCell({ row: 15, col: 5 }, baseLayout, {
        clampToActiveGrid: true,
      }),
    ).toEqual({ row: 6, col: 6 });
  });
});

describe("buildMouseMessage", () => {
  it("returns null when col or row is < 1 (NonZeroU16 contract)", () => {
    expect(
      buildMouseMessage({
        kind: { type: "press", button: "left" },
        col: 0,
        row: 1,
      }),
    ).toBeNull();
    expect(
      buildMouseMessage({
        kind: { type: "press", button: "left" },
        col: 1,
        row: 0,
      }),
    ).toBeNull();
  });

  it("builds a well-formed press message", () => {
    expect(
      buildMouseMessage({
        kind: { type: "press", button: "left" },
        col: 5,
        row: 12,
        mods: { ctrl: true },
      }),
    ).toEqual({
      type: "mouse",
      kind: { type: "press", button: "left" },
      col: 5,
      row: 12,
      mods: { ctrl: true },
    });
  });

  it("builds a wheel_up message without mods", () => {
    expect(
      buildMouseMessage({
        kind: { type: "wheel_up" },
        col: 40,
        row: 24,
      }),
    ).toEqual({
      type: "mouse",
      kind: { type: "wheel_up" },
      col: 40,
      row: 24,
      mods: undefined,
    });
  });
});

describe("wheelLineSteps", () => {
  it("pixel mode: accumulates under threshold, emits when threshold reached", () => {
    const a = wheelLineSteps({
      accumulator: 0,
      deltaY: 5,
      deltaMode: 0,
      cellHeight: 16,
    });
    expect(a.steps).toBe(0);
    expect(a.remainder).toBe(5);

    const b = wheelLineSteps({
      accumulator: 5,
      deltaY: 13,
      deltaMode: 0,
      cellHeight: 16,
    });
    expect(b.steps).toBe(1);
    expect(b.remainder).toBe(2);
  });

  it("pixel mode: negative deltaY produces negative steps (wheel_up)", () => {
    const r = wheelLineSteps({
      accumulator: 0,
      deltaY: -40,
      deltaMode: 0,
      cellHeight: 16,
    });
    expect(r.steps).toBe(-2);
    expect(r.remainder).toBe(-8);
  });

  it("line mode (deltaMode=1): deltaY is taken as steps directly, no accumulator", () => {
    const r = wheelLineSteps({
      accumulator: 99,
      deltaY: 3,
      deltaMode: 1,
      cellHeight: 16,
    });
    expect(r.steps).toBe(3);
    expect(r.remainder).toBe(0);
  });

  it("page mode (deltaMode=2): also direct, accumulator cleared", () => {
    const r = wheelLineSteps({
      accumulator: 99,
      deltaY: -1,
      deltaMode: 2,
      cellHeight: 16,
    });
    expect(r.steps).toBe(-1);
    expect(r.remainder).toBe(0);
  });
});
