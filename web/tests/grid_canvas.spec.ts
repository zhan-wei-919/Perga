import { describe, expect, it } from "vitest";

import {
  canvasBackingSize,
  canvasBackingSizeMatches,
} from "../src/render/grid_canvas";

describe("canvas backing size", () => {
  it("compares the rounded backing-store dimensions", () => {
    const target = canvasBackingSize(
      { rows: 24, cols: 80 },
      { cellW: 7.333, cellH: 18 },
      1,
    );

    expect(target.cssW).not.toBe(target.pixelW);
    expect(canvasBackingSizeMatches({ width: target.pixelW, height: target.pixelH }, target)).toBe(true);
  });
});
