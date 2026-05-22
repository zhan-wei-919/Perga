import { describe, expect, it } from "vitest";

import { measuredCellWidth } from "../src/render/metrics";

describe("measuredCellWidth", () => {
  it("uses the latin cell width when CJK fits in two cells", () => {
    expect(measuredCellWidth(720, 100, 1300, 100)).toBe(7.2);
  });

  it("widens cells when the CJK fallback font needs more room", () => {
    expect(measuredCellWidth(720, 100, 1600, 100)).toBe(8);
  });
});
