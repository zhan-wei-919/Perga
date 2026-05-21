// 单个命令块的 DOM 渲染。
//
// 命令块是「定格的历史」—— 纯 DOM、可选中复制(`user-select: text`),与
// 活动区 Canvas 互补。块内每行 cell 按 (fg,bg,attrs) 合并成 run,控制 DOM
// 节点数(`seq 1 100` 这种块有 100 行)。字体度量与 Canvas 共用同一组常量
// 以保持视觉一致。

import { For, Show, type Component } from "solid-js";

import type { CommandBlock } from "../state/blocks";
import type { Cell, CellAttr, Color } from "../state/protocol";
import { colorToCss } from "./palette";

export type BlockOneProps = {
  block: CommandBlock;
  fontFamily: string;
  fontSize: number;
  onToggleFold: () => void;
};

/// 一行里同 style 的连续 cell 合并成的一段。
export type RowSegment = {
  text: string;
  fg: Color;
  bg: Color;
  attrs: CellAttr[];
};

function isDefaultFg(c: Color): boolean {
  return "named" in c && c.named === "foreground";
}

function isDefaultBg(c: Color): boolean {
  return "named" in c && c.named === "background";
}

function isDefaultBlank(c: Cell): boolean {
  return (
    c.ch === " " &&
    c.combining.length === 0 &&
    c.width === "single" &&
    c.attrs.length === 0 &&
    isDefaultFg(c.fg) &&
    isDefaultBg(c.bg)
  );
}

function sameColor(a: Color, b: Color): boolean {
  if ("named" in a) return "named" in b && a.named === b.named;
  if ("rgb" in a) {
    return (
      "rgb" in b &&
      a.rgb.r === b.rgb.r &&
      a.rgb.g === b.rgb.g &&
      a.rgb.b === b.rgb.b
    );
  }
  return "indexed" in b && a.indexed === b.indexed;
}

function sameAttrs(a: CellAttr[], b: CellAttr[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/// 把一行 cell 合并成 segment。先裁掉行尾的默认空白(复制时不带尾随空格),
/// 再按相同 style 合并。宽字符占位格丢弃 —— 主字符在 monospace 下自占两列。
export function segmentsForRow(cells: Cell[]): RowSegment[] {
  let end = cells.length;
  while (end > 0 && isDefaultBlank(cells[end - 1])) end--;

  const out: RowSegment[] = [];
  let cur: RowSegment | undefined;
  for (let i = 0; i < end; i++) {
    const cell = cells[i];
    if (cell.width === "wide_spacer") continue;
    const glyph =
      cell.combining.length > 0 ? cell.ch + cell.combining.join("") : cell.ch;
    if (
      cur &&
      sameColor(cur.fg, cell.fg) &&
      sameColor(cur.bg, cell.bg) &&
      sameAttrs(cur.attrs, cell.attrs)
    ) {
      cur.text += glyph;
    } else {
      cur = { text: glyph, fg: cell.fg, bg: cell.bg, attrs: cell.attrs };
      out.push(cur);
    }
  }
  return out;
}

/// segment → 内联 CSS。默认背景不落 `background`,让容器底色透出来。
export function segmentStyle(seg: RowSegment): Record<string, string> {
  const reverse = seg.attrs.includes("reverse");
  const fg = reverse ? seg.bg : seg.fg;
  const bg = reverse ? seg.fg : seg.bg;
  const style: Record<string, string> = { color: colorToCss(fg, "fg") };
  if (!isDefaultBg(bg)) style.background = colorToCss(bg, "bg");
  if (seg.attrs.includes("bold")) style["font-weight"] = "bold";
  if (seg.attrs.includes("italic")) style["font-style"] = "italic";
  const deco: string[] = [];
  if (seg.attrs.includes("underline")) deco.push("underline");
  if (seg.attrs.includes("strikethrough")) deco.push("line-through");
  if (deco.length > 0) style["text-decoration"] = deco.join(" ");
  if (seg.attrs.includes("hidden")) style.visibility = "hidden";
  return style;
}

/// exit code → 徽章文字。`null`(shell 没带退出码)= 空。
export function exitLabel(exit: number | null): string {
  if (exit === null) return "";
  return exit === 0 ? "✓" : `✗ ${exit}`;
}

/// exit code → 徽章颜色。
export function exitColor(exit: number | null): string {
  if (exit === null) return "#888888";
  return exit === 0 ? "#0dbc79" : "#f14c4c";
}

const BLOCK_STYLE: Record<string, string> = {
  "border-bottom": "1px solid #2a2a2a",
};

const HEADER_STYLE: Record<string, string> = {
  display: "flex",
  "align-items": "flex-start",
  background: "#252526",
  padding: "1px 6px",
};

const CHEVRON_STYLE: Record<string, string> = {
  cursor: "pointer",
  "user-select": "none",
  color: "#888888",
  "padding-right": "4px",
  flex: "0 0 auto",
};

export const BlockOne: Component<BlockOneProps> = (props) => {
  const lineHeight = (): number => Math.round(props.fontSize * 1.3);

  const contentStyle = (): Record<string, string> => ({
    "font-family": props.fontFamily,
    "font-size": `${props.fontSize}px`,
    "line-height": `${lineHeight()}px`,
    // pre:保留前导空格;块不 reflow,过宽时横向滚动(§7)。
    "white-space": "pre",
    "overflow-x": "auto",
    "user-select": "text",
  });

  const renderRows = (rows: Cell[][]) => (
    <For each={rows}>
      {(cells) => (
        // min-height 让空行也占一行高(空 div 否则塌成 0)。
        <div style={{ "min-height": `${lineHeight()}px` }}>
          <For each={segmentsForRow(cells)}>
            {(seg) => <span style={segmentStyle(seg)}>{seg.text}</span>}
          </For>
        </div>
      )}
    </For>
  );

  return (
    <div style={BLOCK_STYLE}>
      <div style={HEADER_STYLE}>
        <span
          style={CHEVRON_STYLE}
          role="button"
          aria-label="toggle command block fold"
          onClick={() => props.onToggleFold()}
        >
          {props.block.folded ? "▸" : "▾"}
        </span>
        <div style={{ ...contentStyle(), flex: "1", "min-width": "0" }}>
          {renderRows(props.block.command)}
        </div>
        <span
          style={{
            color: exitColor(props.block.exit),
            "padding-left": "6px",
            "user-select": "none",
            flex: "0 0 auto",
          }}
        >
          {exitLabel(props.block.exit)}
        </span>
      </div>
      <Show when={!props.block.folded}>
        <div style={{ ...contentStyle(), background: "#1e1e1e", padding: "1px 6px" }}>
          {renderRows(props.block.output)}
        </div>
      </Show>
    </div>
  );
};
