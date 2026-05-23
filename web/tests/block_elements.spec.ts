import { describe, expect, it } from "vitest";

import {
  blockElementModel,
  isBlockElementGlyph,
  isBlockElementRun,
} from "../src/render/block_elements";

describe("block element model", () => {
  it("maps half and full block glyphs to cell-relative rectangles", () => {
    expect(blockElementModel("▀")).toEqual({
      rects: [{ x: 0, y: 0, w: 1, h: 0.5 }],
    });
    expect(blockElementModel("▄")).toEqual({
      rects: [{ x: 0, y: 0.5, w: 1, h: 0.5 }],
    });
    expect(blockElementModel("█")).toEqual({
      rects: [{ x: 0, y: 0, w: 1, h: 1 }],
    });
  });

  it("maps quadrant blocks without relying on font glyph fill", () => {
    expect(blockElementModel("▟")).toEqual({
      rects: [
        { x: 0, y: 0.5, w: 1, h: 0.5 },
        { x: 0.5, y: 0, w: 0.5, h: 0.5 },
      ],
    });
  });

  it("recognizes only supported block element runs", () => {
    expect(isBlockElementGlyph("▄")).toBe(true);
    expect(isBlockElementGlyph("╭")).toBe(false);
    expect(isBlockElementRun("▀▄█")).toBe(true);
    expect(isBlockElementRun("▀ crab ▄")).toBe(false);
  });
});
