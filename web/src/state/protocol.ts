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
    }
  | {
      type: "patch";
      seq: number;
      cursor: Cursor;
      dirty_rows: { index: number; entries: RowEntry[] }[];
      // 本帧从 viewport 顶滚出、进入历史的行(chronological,最早滚出在前),
      // RLE 编码。前端 append 进自己的 history buffer。多数帧无此字段(空)。
      scrolled_rows?: RowEntry[][];
      // CSI 3J 清 scrollback —— 前端收到先清空 history。多数帧无此字段。
      cleared?: boolean;
      modes?: TerminalModes;
      title?: TitleChange;
    }
  | { type: "exited"; seq: number; status: ExitStatus }
  // 一条命令跑完,后端在 emit 对应 patch 之前发。exit 是退出码,line 是命令
  // 输入行的绝对行号 —— 前端据此在历史里给失败命令打标记。
  | {
      type: "command_end";
      seq: number;
      exit: number | null;
      line: number;
    }
  // **会话在开始前就失败了**(SSH path 专用:profile 不存在 / connect 失败 /
  // auth 失败 / host key mismatch)。reason 是可读字符串,前端 pane 渲染成
  // 错误 banner。不发 `exited` —— 远端 shell 根本没起来,语义不是"退出"
  // 而是"从未开始"。后端发完立即 close WS。
  | { type: "session_error"; seq: number; reason: string };

// 默认色常量。RowEntry::Text 没带 fg/bg/attrs 时落到这里。
export const DEFAULT_FG: Color = { named: "foreground" };
export const DEFAULT_BG: Color = { named: "background" };
