import { describe, expect, it } from "vitest";

import { FONT_IDS, FONT_PRESETS, fontFamilyFor } from "../src/render/fonts";

describe("font presets", () => {
  it("每个字体预设都有可用 fallback", () => {
    for (const id of FONT_IDS) {
      expect(FONT_PRESETS[id].family, id).toContain("monospace");
    }
  });

  it("fontFamilyFor 返回对应预设", () => {
    expect(fontFamilyFor("compact")).toBe(FONT_PRESETS.compact.family);
  });
});
