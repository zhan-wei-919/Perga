import { describe, expect, it } from "vitest";

import { measuredCellWidth } from "../src/render/metrics";

describe("measuredCellWidth", () => {
  it("uses the latin monospace advance as the terminal cell width", () => {
    expect(measuredCellWidth(720, 100)).toBe(7.2);
  });

  it("keeps fractional advances instead of rounding each cell", () => {
    expect(measuredCellWidth(755, 100)).toBe(7.55);
  });
});
