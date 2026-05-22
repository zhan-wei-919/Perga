// 行渲染段单测(row_segments.ts)。从原 blocks.spec.ts 迁移。

import { describe, expect, it } from "vitest";

import { segmentStyle, segmentsForRow } from "../src/render/row_segments";
import type { Cell, Color } from "../src/state/protocol";

const FG: Color = { named: "foreground" };
const BG: Color = { named: "background" };
// combining acute(U+0301)。
const ACUTE = "́";

function cell(ch: string, opts: Partial<Cell> = {}): Cell {
  return { ch, combining: [], width: "single", fg: FG, bg: BG, attrs: [], ...opts };
}

describe("segmentsForRow", () => {
  it("merges consecutive same-style cells", () => {
    const segs = segmentsForRow([cell("a"), cell("b"), cell("c")]);
    expect(segs).toHaveLength(1);
    expect(segs[0].text).toBe("abc");
  });

  it("breaks segments on style change", () => {
    const red: Color = { named: "red" };
    const segs = segmentsForRow([cell("a"), cell("b", { fg: red }), cell("c")]);
    expect(segs.map((s) => s.text)).toEqual(["a", "b", "c"]);
  });

  it("trims trailing default blanks", () => {
    const segs = segmentsForRow([cell("h"), cell("i"), cell(" "), cell(" ")]);
    expect(segs).toHaveLength(1);
    expect(segs[0].text).toBe("hi");
  });

  it("an all-blank row yields no segments", () => {
    expect(segmentsForRow([cell(" "), cell(" ")])).toEqual([]);
  });

  it("skips wide spacer, keeps the wide glyph", () => {
    const segs = segmentsForRow([
      cell("中", { width: "wide" }),
      cell(" ", { width: "wide_spacer" }),
      cell("x"),
    ]);
    expect(segs.map((s) => s.text).join("")).toBe("中x");
  });

  it("keeps combining marks attached to the base glyph", () => {
    const segs = segmentsForRow([cell("e", { combining: [ACUTE] })]);
    expect(segs[0].text).toBe("e" + ACUTE);
  });
});

describe("segmentStyle", () => {
  it("omits background for default bg", () => {
    const style = segmentStyle({ text: "x", fg: FG, bg: BG, attrs: [] });
    expect(style.background).toBeUndefined();
    expect(style.color).toBeTruthy();
  });

  it("reverse swaps fg/bg so background gets painted", () => {
    const style = segmentStyle({ text: "x", fg: FG, bg: BG, attrs: ["reverse"] });
    expect(style.background).toBeTruthy();
  });

  it("maps text attrs to CSS", () => {
    const style = segmentStyle({
      text: "x",
      fg: FG,
      bg: BG,
      attrs: ["bold", "italic", "underline"],
    });
    expect(style["font-weight"]).toBe("bold");
    expect(style["font-style"]).toBe("italic");
    expect(style["text-decoration"]).toContain("underline");
  });
});
