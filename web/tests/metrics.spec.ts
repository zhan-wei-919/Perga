import { describe, expect, it } from "vitest";

import { isFixedPitchWidths, measuredCellWidth } from "../src/render/metrics";

describe("measuredCellWidth", () => {
  it("uses the latin monospace advance as the terminal cell width", () => {
    expect(measuredCellWidth(720, 100)).toBe(7.2);
  });

  it("keeps fractional advances instead of rounding each cell", () => {
    expect(measuredCellWidth(755, 100)).toBe(7.55);
  });
});

describe("isFixedPitchWidths", () => {
  it("accepts small sub-pixel differences", () => {
    expect(isFixedPitchWidths([720, 721, 719])).toBe(true);
  });

  it("rejects proportional advances", () => {
    expect(isFixedPitchWidths([900, 350, 700])).toBe(false);
  });
});
