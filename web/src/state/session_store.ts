// Solid 集成层:把协议事件接到 `createStore` 上。
//
// Solid store 只保存稀疏视图状态;grid 是普通数组 backing buffer。Canvas
// 订阅 rowGen[r] 触发重绘,但热路径读取 raw grid,避免 Solid proxy trap。

import { createStore, produce } from "solid-js/store";

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
};

export function createSessionStore(size: TerminalSize): SessionStore {
  const grid = blankGrid(size);
  const [state, setState] = createStore<SessionViewState>(emptyViewState(size));

  function dispatch(ev: ProtocolEvent): void {
    switch (ev.type) {
      case "init":
        replaceGridRows(grid, ev.rows, ev.size);
        setState({
          size: ev.size,
          cursor: ev.cursor,
          modes: ev.modes,
          title: ev.title,
          rowGen: new Array(ev.size.rows).fill(1),
          seq: ev.seq,
          exited: false,
        });
        return;

      case "patch": {
        const touchedRows = applyDirtyRowsToGrid(grid, ev.dirty_rows, state.size);
        setState(
          produce((draft) => {
            draft.cursor = ev.cursor;
            draft.seq = ev.seq;
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

  return { state, grid, dispatch };
}
