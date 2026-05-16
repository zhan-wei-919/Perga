//! 协议事件类型。`ProtocolEvent` 是协议表面的全部 ── 三类事件:
//! `Init` / `Patch` / `Exited`。

use serde::Serialize;
use terminal_engine::{Cell, Cursor, Row, TerminalModes, TerminalSize};

/// 协议事件。`tag = "type"` 模式,前端按 `msg.type` switch。
///
/// 任何变体都带 `seq`,Encoder 内部单调递增,前端可做 sanity check。本机 IPC
/// 顺序有保证,不需要 ARQ。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProtocolEvent {
    /// 完整帧。Encoder 第一次调用 / engine resize 后发。前端拿到后**必须**
    /// 清空本地 grid,用这一帧重建。
    Init {
        seq: u64,
        size: TerminalSize,
        cursor: Cursor,
        rows: Vec<Row>,
        modes: TerminalModes,
        title: Option<String>,
    },
    /// 增量帧。`dirty_rows` 可能为空(只光标动了一格);`modes` / `title` 变
    /// 了才带,否则 wire format 上不出现这两个 key。
    Patch {
        seq: u64,
        cursor: Cursor,
        dirty_rows: Vec<DirtyRow>,
        #[serde(skip_serializing_if = "Option::is_none")]
        modes: Option<TerminalModes>,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<TitleChange>,
    },
    /// 子进程退出。由上层在 `PtyEvent::Exited` 时驱动 Encoder 产生。
    Exited { seq: u64, status: ExitStatus },
}

/// Patch 里的脏行 ── 整行替换语义,前端按 `index` 整行覆盖。
///
/// 第一刀**不**做列范围 patch:Cell-level 替换在 JS 端并不比整行更快,而协议
/// 形状会多一个维度。真要做再加 `left/right` 字段。
#[derive(Debug, Clone, Serialize)]
pub struct DirtyRow {
    pub index: u16,
    pub cells: Vec<Cell>,
}

/// 标题变更类型。`Set` 来自 OSC 0/2,`Reset` 来自 alacritty 的 `ResetTitle`
/// 事件 ── 两者语义不同(显式置空 vs 回退默认),前端可能要分别处理。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TitleChange {
    Set { value: String },
    Reset,
}

/// 协议层退出状态。
///
/// 字段同时保留 `code` 和 `signal`,即使当前 pty crate 的 `ExitStatus` 只
/// 暴露 `code: u32`(signal 信息未透出)。本层 `signal` 当前永远 `None`,
/// 留给 pty 层未来扩展时无缝接入,**不**算违反「不为未来写代码」── signal
/// 是 Unix 子进程退出状态的最小完备形态,协议表面一开始就应该长这样。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ExitStatus {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}
