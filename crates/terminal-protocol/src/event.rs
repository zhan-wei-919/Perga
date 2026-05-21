//! 协议事件类型。`ProtocolEvent` 是协议表面的全部 ── 四类事件:
//! `Init` / `Patch` / `Exited` / `CommandBlock`。
//!
//! Grid 内容用 [`RowEntry`] 做行内 RLE 压缩,见类型文档。

use serde::Serialize;
use terminal_engine::{Cell, CellAttrs, Color, Cursor, NamedColor, TerminalModes, TerminalSize};

/// 协议事件。`tag = "type"` 模式,前端按 `msg.type` switch。
///
/// 任何变体都带 `seq`,Encoder 内部单调递增,前端可做 sanity check。本机 IPC
/// 顺序有保证,不需要 ARQ。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProtocolEvent {
    /// 完整帧。Encoder 第一次调用 / engine resize 后发。前端拿到后**必须**
    /// 清空本地 grid,用这一帧重建。
    ///
    /// `rows.len() == size.rows`,行号 = 数组索引(positional)。每一行是一个
    /// `Vec<RowEntry>`,entries 顺序展开后必须正好填满 `size.cols` 列。
    ///
    /// `active_top` 含义见 [`ProtocolEvent::Patch`]。
    Init {
        seq: u64,
        size: TerminalSize,
        cursor: Cursor,
        rows: Vec<Vec<RowEntry>>,
        modes: TerminalModes,
        title: Option<String>,
        active_top: u16,
    },
    /// 增量帧。`dirty_rows` 可能为空(只光标动了一格);`modes` / `title` 变
    /// 了才带,否则 wire format 上不出现这两个 key。
    ///
    /// `active_top`:Canvas 活动区起始视口行。前端 Canvas 只渲染
    /// `[active_top, size.rows)`;`[0, active_top)` 的内容已被命令块收走。
    /// **每帧必发**(后端每帧重算,从不 stale);无 shell 集成 / alt-screen
    /// 时为 0(Canvas 全屏)。
    Patch {
        seq: u64,
        cursor: Cursor,
        dirty_rows: Vec<DirtyRow>,
        active_top: u16,
        #[serde(skip_serializing_if = "Option::is_none")]
        modes: Option<TerminalModes>,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<TitleChange>,
    },
    /// 子进程退出。由上层在 `PtyEvent::Exited` 时驱动 Encoder 产生。
    Exited { seq: u64, status: ExitStatus },
    /// 一条跑完的命令收成的命令块。后端在收到 OSC 133 `D` 标记时组装并下发,
    /// **在对应的 `Patch` 之前**。
    ///
    /// `command` 是命令头(提示符 + 用户输入的命令行)各行,`output` 是命令
    /// 输出各行,都用 `RowEntry` RLE 编码。前端直接渲染成 DOM 块,不切自己的
    /// 视口。`exit` 是退出码,shell 没带时 `None`。
    CommandBlock {
        seq: u64,
        exit: Option<i32>,
        command: Vec<Vec<RowEntry>>,
        output: Vec<Vec<RowEntry>>,
    },
}

/// Patch 里的脏行 ── 整行替换语义,前端按 `index` 整行覆盖。
///
/// `entries` 顺序展开后必须覆盖整行(`size.cols` 列)。
#[derive(Debug, Clone, Serialize)]
pub struct DirtyRow {
    pub index: u16,
    pub entries: Vec<RowEntry>,
}

/// 行内 entry。row 内做混合 RLE:空白游程、共享属性的文本游程、兜底 cells 数组。
///
/// `tag = "type"` 与 [`ProtocolEvent`] 一致,前端 switch 走分支。
///
/// **协议契约**:
/// - 一行内所有 entry 的「占用列数」之和 = `size.cols`。
/// - `Text.s` 中每个 char 占一列(单宽)。
/// - `Cells.cells` 中每个 `Cell` 占一列 ── wide char 在网格里占两列,所以
///   `Cells` 数组里 `Wide` cell **总是**紧跟一个 `WideSpacer` cell。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RowEntry {
    /// 连续 `count` 个 [`Cell::is_default_blank`] 为 true 的 cell。
    /// 默认空白 = ch=' ', combining 空, width=Single, fg=Foreground,
    /// bg=Background, attrs 空。
    Blank { count: u16 },

    /// 共享属性的单宽字符串。`s.chars().count()` = 这段占用的列数。
    /// **不**含 combining mark / wide char ── 那两种走 [`RowEntry::Cells`]。
    ///
    /// `fg` / `bg` / `attrs` 是默认值时通过 `skip_serializing_if` 隐去,前端
    /// 缺这个 key 时就当默认(Foreground / Background / empty attrs)。
    Text {
        s: String,
        #[serde(skip_serializing_if = "is_default_fg")]
        fg: Color,
        #[serde(skip_serializing_if = "is_default_bg")]
        bg: Color,
        #[serde(skip_serializing_if = "CellAttrs::is_empty")]
        attrs: CellAttrs,
    },

    /// 兜底:wide char + spacer 对、带 combining mark 的 cell。前端按 cells
    /// 数组逐 cell 覆盖对应列。
    Cells { cells: Vec<Cell> },
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

fn is_default_fg(c: &Color) -> bool {
    matches!(c, Color::Named(NamedColor::Foreground))
}

fn is_default_bg(c: &Color) -> bool {
    matches!(c, Color::Named(NamedColor::Background))
}
