import { describe, expect, it } from "vitest";

import {
  canvasBackingSize,
  canvasBackingSizeMatches,
} from "../src/render/grid_canvas";

const M = { cellW: 7.333, cellH: 18 };

describe("canvas backing size", () => {
  it("compares the rounded backing-store dimensions", () => {
    const target = canvasBackingSize({ rows: 24, cols: 80 }, M, 1, 0);

    expect(target.cssW).not.toBe(target.pixelW);
    expect(
      canvasBackingSizeMatches(
        { width: target.pixelW, height: target.pixelH },
        target,
      ),
    ).toBe(true);
  });

  it("activeTop clips the canvas to the active region", () => {
    const full = canvasBackingSize({ rows: 24, cols: 80 }, M, 1, 0);
    const clipped = canvasBackingSize({ rows: 24, cols: 80 }, M, 1, 10);
    // 裁掉 10 行 → 高度 = 14 行。
    expect(clipped.cssH).toBe(14 * M.cellH);
    expect(clipped.cssH).toBeLessThan(full.cssH);
    // 宽度不受 activeTop 影响。
    expect(clipped.cssW).toBe(full.cssW);
  });

  it("activeTop == rows yields a zero-height canvas without crashing", () => {
    const empty = canvasBackingSize({ rows: 24, cols: 80 }, M, 1, 24);
    expect(empty.cssH).toBe(0);
    expect(empty.pixelH).toBe(0);
  });
});
