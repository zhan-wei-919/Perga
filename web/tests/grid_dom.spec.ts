import { describe, expect, it } from "vitest";

import {
  cursorOverlayModel,
  debugGridRowSegments,
  gridDomSize,
  segmentsForGridRow,
} from "../src/render/grid_dom";
import type { Cell, Color } from "../src/state/protocol";

const FG: Color = { named: "foreground" };
const BG: Color = { named: "background" };
const RED: Color = { named: "red" };
const ACUTE = "́";

function cell(ch: string, opts: Partial<Cell> = {}): Cell {
  return {
    ch,
    combining: [],
    width: "single",
    fg: FG,
    bg: BG,
    attrs: [],
    ...opts,
  };
}

describe("gridDomSize", () => {
  it("sizes the DOM grid to the full viewport", () => {
    expect(gridDomSize({ rows: 24, cols: 80 }, { cellW: 7.5, cellH: 18 })).toEqual({
      cssW: 600,
      cssH: 432,
    });
  });
});

describe("segmentsForGridRow", () => {
  it("merges consecutive same-style cells", () => {
    const segs = segmentsForGridRow([cell("a"), cell("b"), cell("c")], 3);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ text: "abc", widthCells: 3 });
  });

  it("breaks on style changes", () => {
    const segs = segmentsForGridRow([cell("a"), cell("b", { fg: RED }), cell("c")], 3);
    expect(segs.map((s) => s.text)).toEqual(["a", "b", "c"]);
  });

  it("keeps interior spaces and trims trailing default blanks", () => {
    const segs = debugGridRowSegments(
      [cell("a"), cell(" "), cell("b"), cell(" "), cell(" ")],
      5,
    );
    expect(segs).toEqual([
      { xCell: 0, text: "a", widthCells: 1 },
      { xCell: 2, text: "b", widthCells: 1 },
    ]);
  });

  it("keeps trailing blanks when their background is meaningful", () => {
    const segs = segmentsForGridRow(
      [cell("x"), cell(" ", { bg: RED }), cell(" ", { bg: RED })],
      3,
    );
    expect(segs.map((s) => s.text)).toEqual(["x", "  "]);
    expect(segs[1].widthCells).toBe(2);
  });

  it("trims trailing default blanks because cursor is rendered as overlay", () => {
    const segs = segmentsForGridRow([cell("x"), cell(" "), cell(" ")], 3);
    expect(segs.map((s) => s.text)).toEqual(["x"]);
  });

  it("keeps wide glyphs as two-cell standalone segments", () => {
    const segs = segmentsForGridRow(
      [
        cell("中", { width: "wide" }),
        cell(" ", { width: "wide_spacer" }),
        cell("x"),
      ],
      3,
    );
    expect(segs.map((s) => [s.text, s.widthCells])).toEqual([
      ["中", 2],
      ["x", 1],
    ]);
  });

  it("groups adjacent wide glyphs so browser fallback fonts do not insert per-glyph gaps", () => {
    const segs = debugGridRowSegments(
      [
        cell("公", { width: "wide" }),
        cell(" ", { width: "wide_spacer" }),
        cell("共", { width: "wide" }),
        cell(" ", { width: "wide_spacer" }),
        cell("x"),
      ],
      5,
    );
    expect(segs).toEqual([
      { xCell: 0, text: "公共", widthCells: 4 },
      { xCell: 4, text: "x", widthCells: 1 },
    ]);
  });

  it("serializes column positions across styled gaps for debugging", () => {
    const blue: Color = { named: "blue" };
    const row = [
      ...Array.from("apps", (ch) => cell(ch, { fg: blue })),
      cell(" "),
      cell(" "),
      cell(" "),
      cell(" "),
      ...Array.from("key", (ch) => cell(ch)),
    ];

    expect(debugGridRowSegments(row, row.length)).toEqual([
      { xCell: 0, text: "apps", widthCells: 4 },
      { xCell: 8, text: "key", widthCells: 3 },
    ]);
  });

  it("keeps combining marks attached to the base glyph", () => {
    const segs = segmentsForGridRow([cell("e", { combining: [ACUTE] })], 1);
    expect(segs[0].text).toBe("e" + ACUTE);
  });

  it("splits box drawing glyphs from same-style text runs", () => {
    const row = Array.from("╭── Claude ─╮", (ch) => cell(ch));

    expect(debugGridRowSegments(row, row.length)).toEqual([
      { xCell: 0, text: "╭──", widthCells: 3 },
      { xCell: 4, text: "Claude", widthCells: 6 },
      { xCell: 11, text: "─╮", widthCells: 2 },
    ]);
  });

  it("splits block element glyphs from same-style text runs", () => {
    const row = Array.from(" crab ▀▄█ ", (ch) => cell(ch));

    expect(debugGridRowSegments(row, row.length)).toEqual([
      { xCell: 1, text: "crab", widthCells: 4 },
      { xCell: 6, text: "▀▄█", widthCells: 3 },
    ]);
  });
});

describe("cursorOverlayModel", () => {
  const M = { cellW: 7.5, cellH: 18 };

  it("renders block cursor as one overlay without dirtying rows", () => {
    const cursor = { row: 3, col: 8, visible: true, style: "block" as const };
    const model = cursorOverlayModel(cursor, cell("x"), M);

    expect(model).toMatchObject({
      x: 60,
      y: 54,
      width: 7.5,
      height: 18,
      text: "x",
    });
    expect(model?.color).toBe("var(--term-background)");
    expect(model?.background).toBe("var(--term-foreground)");
  });

  it("spans two cells over a wide glyph", () => {
    const cursor = { row: 1, col: 2, visible: true, style: "block" as const };
    const model = cursorOverlayModel(cursor, cell("中", { width: "wide" }), M);

    expect(model?.width).toBe(15);
    expect(model?.text).toBe("中");
  });

  it("renders underline cursor at the bottom of its cell", () => {
    const cursor = { row: 1, col: 2, visible: true, style: "underline" as const };
    const model = cursorOverlayModel(cursor, cell("x"), M);

    expect(model).toMatchObject({
      width: 7.5,
      height: 2,
      marginTop: 16,
      text: "",
    });
  });
});
