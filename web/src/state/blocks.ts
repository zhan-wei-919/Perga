// 命令块模型 —— 一条跑完的命令收成的可选中 / 可折叠 DOM 块。
//
// 后端在 OSC 133 `D` 时组装好 `command_block` 协议事件下发,这里把它解码成
// 展开后的 `Cell[][]`(和 grid 一样,不保留 RLE —— 渲染层不做二次解码)。
// 块一旦建好内容就不可变,只有 `folded` 会被用户切换。

import type { Cell, ProtocolEvent, RowEntry } from "./protocol";
import { expandRowEntries } from "./session";

export type CommandBlock = {
  // 用协议事件的 seq 当稳定 id —— 单调唯一,<For> 可据它 key。
  id: number;
  // 退出码;shell 没带时 null。
  exit: number | null;
  // 命令头(提示符 + 输入的命令行)各行。
  command: Cell[][];
  // 命令输出各行;无输出命令为空数组。
  output: Cell[][];
  // 折叠态:折叠后只显示命令头。
  folded: boolean;
};

/// 一行 RowEntry 展开后占用的列数。
function entriesWidth(entries: RowEntry[]): number {
  let w = 0;
  for (const e of entries) {
    if (e.type === "blank") w += e.count;
    else if (e.type === "text") w += [...e.s].length;
    else w += e.cells.length;
  }
  return w;
}

/// 把 `command_block` 协议事件解码成 [`CommandBlock`]。
///
/// 每行展开到**自己的自然宽度** —— 块捕获后不 reflow,保持原列宽(§7 决策),
/// 所以这里不强行对齐到当前终端宽度。
export function commandBlockFromEvent(
  ev: Extract<ProtocolEvent, { type: "command_block" }>,
): CommandBlock {
  const expand = (rows: RowEntry[][]): Cell[][] =>
    rows.map((entries) => expandRowEntries(entries, entriesWidth(entries)));
  return {
    id: ev.seq,
    exit: ev.exit,
    command: expand(ev.command),
    output: expand(ev.output),
    folded: false,
  };
}
