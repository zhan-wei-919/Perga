// 命令块单测:模型解码(blocks.ts)+ 行渲染纯逻辑(block_one.tsx)。
// 沿用本项目惯例 —— 测纯导出函数,不挂载组件。

import { describe, expect, it } from "vitest";

import {
  exitColor,
  exitLabel,
  segmentStyle,
  segmentsForRow,
} from "../src/render/block_one";
import { commandBlockFromEvent } from "../src/state/blocks";
import type { Cell, Color } from "../src/state/protocol";

const FG: Color = { named: "foreground" };
const BG: Color = { named: "background" };

function cell(ch: string, opts: Partial<Cell> = {}): Cell {
  return { ch, combining: [], width: "single", fg: FG, bg: BG, attrs: [], ...opts };
}

describe("commandBlockFromEvent", () => {
  it("decodes command + output rows to their natural widths", () => {
    const block = commandBlockFromEvent({
      type: "command_block",
      seq: 9,
      exit: 0,
      command: [[{ type: "text", s: "$ ls" }]],
      output: [[{ type: "text", s: "file.txt" }]],
    });
    expect(block.id).toBe(9);
    expect(block.exit).toBe(0);
    expect(block.folded).toBe(false);
    expect(block.command[0]).toHaveLength(4);
    expect(block.command[0].map((c) => c.ch).join("")).toBe("$ ls");
    expect(block.output[0]).toHaveLength(8);
  });

  it("handles empty output", () => {
    const block = commandBlockFromEvent({
      type: "command_block",
      seq: 1,
      exit: null,
      command: [[{ type: "text", s: "$ true" }]],
      output: [],
    });
    expect(block.output).toEqual([]);
    expect(block.exit).toBeNull();
  });
});

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
    const segs = segmentsForRow([cell("e", { combining: ["́"] })]);
    expect(segs[0].text).toBe("é");
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

describe("exit badge", () => {
  it("labels success / failure / unknown", () => {
    expect(exitLabel(0)).toBe("✓");
    expect(exitLabel(1)).toContain("1");
    expect(exitLabel(null)).toBe("");
  });

  it("colors success and failure differently", () => {
    expect(exitColor(0)).not.toBe(exitColor(1));
  });
});
