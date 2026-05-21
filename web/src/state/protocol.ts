// 与 Rust `terminal-protocol` crate 的 wire 形状一一对齐。
// 任何字段调整都要在两端同步,否则反序列化失败。
//
// 这一层是**纯类型**:不带运行时逻辑,Vitest 不需要 import 它就能跑解码。

export type NamedColor =
  | "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white"
  | "bright_black" | "bright_red" | "bright_green" | "bright_yellow"
  | "bright_blue" | "bright_magenta" | "bright_cyan" | "bright_white"
  | "foreground" | "background" | "cursor"
  | "dim_black" | "dim_red" | "dim_green" | "dim_yellow" | "dim_blue"
  | "dim_magenta" | "dim_cyan" | "dim_white"
  | "bright_foreground" | "dim_foreground";

export type Color =
  | { named: NamedColor }
  | { indexed: number }
  | { rgb: { r: number; g: number; b: number } };

export type CellAttr =
  | "bold" | "dim" | "italic" | "underline" | "reverse" | "hidden" | "strikethrough";

export type CellWidth = "single" | "wide" | "wide_spacer";

export type Cell = {
  ch: string;
  combining: string[];
  width: CellWidth;
  fg: Color;
  bg: Color;
  attrs: CellAttr[];
};

// RLE entry。`fg`/`bg`/`attrs` 缺失 = 默认值(见 protocol crate 的 skip_serializing_if)。
export type RowEntry =
  | { type: "blank"; count: number }
  | {
      type: "text";
      s: string;
      fg?: Color;
      bg?: Color;
      attrs?: CellAttr[];
    }
  | { type: "cells"; cells: Cell[] };

export type Cursor = {
  row: number;
  col: number;
  visible: boolean;
  style: "block" | "underline" | "beam" | "hidden";
};

export type TerminalSize = { rows: number; cols: number };

export type MouseReporting = "off" | "normal" | "button" | "any";

export type TerminalModes = {
  alt_screen: boolean;
  app_cursor: boolean;
  bracketed_paste: boolean;
  mouse_reporting: MouseReporting;
  sgr_mouse: boolean;
  focus_reporting: boolean;
};

export type TitleChange = { kind: "set"; value: string } | { kind: "reset" };

export type ExitStatus = {
  code: number | null;
  signal: number | null;
};

export type ProtocolEvent =
  | {
      type: "init";
      seq: number;
      size: TerminalSize;
      cursor: Cursor;
      rows: RowEntry[][];
      modes: TerminalModes;
      title: string | null;
      // Canvas 活动区起始视口行,含义见 patch.active_top。
      active_top: number;
    }
  | {
      type: "patch";
      seq: number;
      cursor: Cursor;
      dirty_rows: { index: number; entries: RowEntry[] }[];
      // Canvas 只渲染 [active_top, size.rows);[0, active_top) 已被命令块收走。
      // 每帧必发(后端每帧重算),无 shell 集成 / alt-screen 时为 0(全屏)。
      active_top: number;
      modes?: TerminalModes;
      title?: TitleChange;
    }
  | { type: "exited"; seq: number; status: ExitStatus }
  // 一条跑完的命令收成的命令块,后端在 emit 对应 patch 之前发。command 是
  // 命令头各行,output 是输出各行,都是 RowEntry RLE。前端直接渲染成 DOM 块。
  | {
      type: "command_block";
      seq: number;
      exit: number | null;
      command: RowEntry[][];
      output: RowEntry[][];
    };

// 默认色常量。RowEntry::Text 没带 fg/bg/attrs 时落到这里。
export const DEFAULT_FG: Color = { named: "foreground" };
export const DEFAULT_BG: Color = { named: "background" };
