import { describe, expect, it } from "vitest";

import {
  boxDrawingModel,
  boxDrawingStemRect,
  isBoxDrawingGlyph,
  isBoxDrawingRun,
} from "../src/render/box_drawing";

describe("box drawing model", () => {
  it("maps common light and rounded TUI border glyphs to cell-edge stems", () => {
    expect(boxDrawingModel("│")).toEqual({
      stems: ["up", "down"],
      weight: "light",
    });
    expect(boxDrawingModel("╭")).toEqual({
      stems: ["right", "down"],
      weight: "light",
    });
  });

  it("recognizes only supported box drawing runs", () => {
    expect(isBoxDrawingGlyph("─")).toBe(true);
    expect(isBoxDrawingGlyph("a")).toBe(false);
    expect(isBoxDrawingRun("╭──╮")).toBe(true);
    expect(isBoxDrawingRun("╭ title ╮")).toBe(false);
  });

  it("overlaps horizontal stems across fractional cell boundaries", () => {
    const metrics = { cellW: 9.64, cellH: 21, fontSize: 16 };
    const right = boxDrawingStemRect("right", "light", metrics, 0);
    const left = boxDrawingStemRect("left", "light", metrics, 1);

    expect(right.left + right.width).toBeGreaterThan(metrics.cellW);
    expect(left.left).toBeLessThan(metrics.cellW);
  });
});
