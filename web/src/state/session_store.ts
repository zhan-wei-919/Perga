// Solid 集成层:把协议事件接到 `createStore` 上。
//
// Solid store 只保存稀疏视图状态;grid 与 history 是普通数组 backing buffer,
// 在 store 外持有 —— 渲染热路径读它们,不穿 Solid proxy。

import { createStore, produce } from "solid-js/store";

import {
  type HistoryBuffer,
  clearHistory,
  emptyHistory,
  markFailure,
  pushHistoryRows,
} from "./history";
import type { Cell, ProtocolEvent, TerminalSize } from "./protocol";
import {
  applyDirtyRowsToGrid,
  blankGrid,
  emptyViewState,
  expandRowEntries,
  replaceGridRows,
  type SessionViewState,
} from "./session";

export type SessionStore = {
  state: SessionViewState;
  grid: Cell[][];
  history: HistoryBuffer;
  dispatch: (ev: ProtocolEvent) => void;
};

export function createSessionStore(size: TerminalSize): SessionStore {
  const grid = blankGrid(size);
  const history = emptyHistory();
  const [state, setState] = createStore<SessionViewState>(emptyViewState(size));

  // scrollback 编号状态(store 外):
  // - frontendScrollTotal:镜像引擎 scroll_total,init / cleared 时归零。
  // - historyAbsOffset:resize 时累加,保证全局绝对行号跨 resize 唯一。
  // - pendingFailures:失败命令输入行的全局行号,等它滚进 history 再落标记。
  let frontendScrollTotal = 0;
  let historyAbsOffset = 0;
  let pendingFailures: number[] = [];

  /// 把已滚进 history 的 pending 失败行落成标记。返回是否产生了新标记。
  function drainPendingFailures(): boolean {
    if (pendingFailures.length === 0) return false;
    const viewportTop = historyAbsOffset + frontendScrollTotal;
    let changed = false;
    const stillPending: number[] = [];
    for (const globalLine of pendingFailures) {
      if (globalLine < viewportTop) {
        markFailure(history, globalLine);
        changed = true;
      } else {
        stillPending.push(globalLine);
      }
    }
    pendingFailures = stillPending;
    return changed;
  }

  function dispatch(ev: ProtocolEvent): void {
    switch (ev.type) {
      case "init": {
        replaceGridRows(grid, ev.rows, ev.size);
        // resize 也走 init:引擎 scroll_total 归零,这里把 historyAbsOffset
        // 推进旧的 frontendScrollTotal,后续绝对行号不与旧 history 撞。首次
        // connect 时 frontendScrollTotal 为 0,这步是 no-op。
        historyAbsOffset += frontendScrollTotal;
        frontendScrollTotal = 0;
        pendingFailures = [];
        // history / historyLen / failureGen 不列进对象 ── setState 浅合并,
        // 它们因此跨 resize-init 保留(history 是旧内容,不 reflow)。
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
      }

      case "patch": {
        if (ev.cleared) {
          clearHistory(history);
          frontendScrollTotal = 0;
          pendingFailures = [];
        } else if (ev.scrolled_rows && ev.scrolled_rows.length > 0) {
          const decoded = ev.scrolled_rows.map((entries) =>
            expandRowEntries(entries, state.size.cols),
          );
          pushHistoryRows(
            history,
            decoded,
            historyAbsOffset + frontendScrollTotal,
          );
          frontendScrollTotal += ev.scrolled_rows.length;
        }
        const failedChanged = drainPendingFailures();
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
            draft.historyLen = history.rows.length;
            if (failedChanged) draft.failureGen += 1;
          }),
        );
        return;
      }

      case "command_end": {
        // 失败命令:记下输入行的全局绝对行号,等它滚进 history 由
        // drainPendingFailures 落成标记(此刻它可能还在活动区里)。
        // exit 0 / null 不标 —— 成功安静。
        if (ev.exit !== null && ev.exit !== 0) {
          pendingFailures.push(historyAbsOffset + ev.line);
        }
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

  return { state, grid, history, dispatch };
}
