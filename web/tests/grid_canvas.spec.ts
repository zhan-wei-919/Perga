import { describe, expect, it } from "vitest";

import {
  canvasBackingSize,
  canvasBackingSizeMatches,
  cursorCleanupRow,
  rowBackgroundRect,
  textClipRect,
} from "../src/render/grid_canvas";

const M = { cellW: 7.333, cellH: 18 };

describe("canvas backing size", () => {
  it("compares the rounded backing-store dimensions", () => {
    const target = canvasBackingSize({ rows: 24, cols: 80 }, M, 1);

    expect(target.cssW).not.toBe(target.pixelW);
    expect(
      canvasBackingSizeMatches(
        { width: target.pixelW, height: target.pixelH },
        target,
      ),
    ).toBe(true);
  });

  it("sizes the canvas to the full viewport grid", () => {
    const size = canvasBackingSize({ rows: 24, cols: 80 }, M, 1);
    expect(size.cssH).toBe(24 * M.cellH);
    expect(size.cssW).toBe(80 * M.cellW);
  });

  it("scales the backing store by device pixel ratio", () => {
    const size = canvasBackingSize({ rows: 10, cols: 20 }, M, 2);
    expect(size.pixelH).toBe(Math.round(10 * M.cellH * 2));
  });
});

describe("cursor cleanup", () => {
  it("redraws the old cursor row when only the cursor moved", () => {
    const last = { row: 3, col: 8, visible: true, style: "block" as const };
    const next = { row: 3, col: 9, visible: true, style: "block" as const };

    expect(cursorCleanupRow(last, next, new Set())).toBe(3);
  });

  it("skips cleanup when the old cursor row is already dirty", () => {
    const last = { row: 3, col: 8, visible: true, style: "block" as const };
    const next = { row: 3, col: 9, visible: true, style: "block" as const };

    expect(cursorCleanupRow(last, next, new Set([3]))).toBeNull();
  });
});

describe("row background clear", () => {
  it("clears the whole row before segmented redraws", () => {
    expect(rowBackgroundRect(2, { cellW: 7.333, cellH: 18 }, 80)).toEqual({
      x: 0,
      y: 36,
      w: 586.64,
      h: 18,
    });
  });
});

describe("text clipping", () => {
  it("clips wide glyph drawing to its two-cell slot", () => {
    const rect = textClipRect(1, 3, 2, { cellW: 7.333, cellH: 18 });
    expect(rect.x).toBeCloseTo(21.999);
    expect(rect.y).toBe(18);
    expect(rect.w).toBeCloseTo(14.666);
    expect(rect.h).toBe(18);
  });
});
