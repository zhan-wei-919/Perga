// Solid 集成层:把协议事件接到 `createStore` 上。
//
// Solid store 只保存稀疏视图状态;grid 是普通数组 backing buffer。Canvas
// 订阅 rowGen[r] 触发重绘,但热路径读取 raw grid,避免 Solid proxy trap。

import { createStore, produce } from "solid-js/store";

import { commandBlockFromEvent } from "./blocks";
import type { Cell, ProtocolEvent, TerminalSize } from "./protocol";
import {
  applyDirtyRowsToGrid,
  blankGrid,
  emptyViewState,
  replaceGridRows,
  type SessionViewState,
} from "./session";

export type SessionStore = {
  state: SessionViewState;
  grid: Cell[][];
  dispatch: (ev: ProtocolEvent) => void;
  /// 切换某个命令块的折叠态。纯 UI 操作,不走协议。
  toggleBlockFold: (id: number) => void;
};

export function createSessionStore(size: TerminalSize): SessionStore {
  const grid = blankGrid(size);
  const [state, setState] = createStore<SessionViewState>(emptyViewState(size));

  function dispatch(ev: ProtocolEvent): void {
    switch (ev.type) {
      case "init":
        replaceGridRows(grid, ev.rows, ev.size);
        // 不把 blocks 列进对象 ── setState 是浅合并,blocks 因此跨 resize-init
        // 保留(已下发的命令块是冻结历史,F9)。
        setState({
          size: ev.size,
          cursor: ev.cursor,
          modes: ev.modes,
          title: ev.title,
          rowGen: new Array(ev.size.rows).fill(1),
          seq: ev.seq,
          exited: false,
          activeTop: ev.active_top,
        });
        return;

      case "patch": {
        const touchedRows = applyDirtyRowsToGrid(grid, ev.dirty_rows, state.size);
        setState(
          produce((draft) => {
            draft.cursor = ev.cursor;
            draft.seq = ev.seq;
            draft.activeTop = ev.active_top;
            if (ev.modes) draft.modes = ev.modes;
            if (ev.title) {
              draft.title = ev.title.kind === "set" ? ev.title.value : null;
            }
            for (const index of touchedRows) {
              draft.rowGen[index] = (draft.rowGen[index] ?? 0) + 1;
            }
          }),
        );
        return;
      }

      case "command_block": {
        // 解码在 produce 外做,只把成品 push 进 store。command_block 总在对应
        // patch 之前到,前端据此先收块、随后的 patch 再裁 Canvas。
        const block = commandBlockFromEvent(ev);
        setState(
          produce((draft) => {
            draft.blocks.push(block);
            draft.seq = ev.seq;
          }),
        );
        return;
      }

      case "exited":
        setState(
          produce((draft) => {
            draft.exited = true;
            draft.seq = ev.seq;
          }),
        );
        return;
    }
  }

  function toggleBlockFold(id: number): void {
    setState(
      produce((draft) => {
        const blk = draft.blocks.find((b) => b.id === id);
        if (blk) blk.folded = !blk.folded;
      }),
    );
  }

  return { state, grid, dispatch, toggleBlockFold };
}
