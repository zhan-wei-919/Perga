//! 协议事件类型。`ProtocolEvent` 是协议表面的全部 ── 四类事件:
//! `Init` / `Patch` / `Exited` / `CommandEnd`。
//!
//! Grid 内容用 [`RowEntry`] 做行内 RLE 压缩,见类型文档。

use serde::Serialize;
use terminal_engine::{Cell, CellAttrs, Color, Cursor, NamedColor, TerminalModes, TerminalSize};
pub use transport::ExitStatus;

/// 协议事件。`tag = "type"` 模式,前端按 `msg.type` switch。
///
/// 任何变体都带 `seq`,Encoder 内部单调递增,前端可做 sanity check。本机 IPC
/// 顺序有保证,不需要 ARQ。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProtocolEvent {
    /// 完整帧。Encoder 第一次调用 / engine resize 后发。前端拿到后**必须**
    /// 清空本地 grid,用这一帧重建(history buffer 不清 —— 跨 resize 保留)。
    ///
    /// `rows.len() == size.rows`,行号 = 数组索引(positional)。每一行是一个
    /// `Vec<RowEntry>`,entries 顺序展开后必须正好填满 `size.cols` 列。
    Init {
        seq: u64,
        size: TerminalSize,
        cursor: Cursor,
        rows: Vec<Vec<RowEntry>>,
        modes: TerminalModes,
        title: Option<String>,
    },
    /// 增量帧。`dirty_rows` 可能为空(只光标动了一格);`modes` / `title` 变
    /// 了才带,否则 wire format 上不出现这两个 key。
    ///
    /// `scrolled_rows`:本帧从 viewport 顶滚出、进入历史的行,chronological
    /// (最早滚出在前),`RowEntry` RLE 编码。前端把它 append 进自己持有的
    /// history buffer —— scrollback 由前端累积,后端读一次转发一次、不存历史。
    /// 绝大多数帧为空,空时 wire 上不出现这个 key。
    ///
    /// `cleared`:`CSI 3J`(清 scrollback)发生 —— 前端收到先清空 history,
    /// 再 apply `dirty_rows`。此时 `scrolled_rows` 必为空。false 时 wire 上
    /// 不出现这个 key。
    Patch {
        seq: u64,
        cursor: Cursor,
        dirty_rows: Vec<DirtyRow>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        scrolled_rows: Vec<Vec<RowEntry>>,
        #[serde(skip_serializing_if = "is_false")]
        cleared: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        modes: Option<TerminalModes>,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<TitleChange>,
    },
    /// 子进程退出。由上层在 `PtyEvent::Exited` 时驱动 Encoder 产生。
    Exited { seq: u64, status: ExitStatus },
    /// 一条命令跑完。后端收到 OSC 133 `D` 标记时下发,**在对应的 `Patch`
    /// 之前**。`exit` 是退出码(shell 没带时 `None`);`line` 是命令输入行的
    /// 绝对行号 —— 前端据此在历史里给失败命令打标记。所有命令(含 exit 0)
    /// 都发,autotest 靠它做确定性的「命令跑完」判定。
    CommandEnd {
        seq: u64,
        exit: Option<i32>,
        line: u64,
    },
    /// **会话在开始前就失败了**。专用于 SSH 路径:服务端在 WS upgrade 之后
    /// 跑 connect + auth + open_shell,失败时下发这个事件 + 关 WS。前端 pane
    /// 拿到后显示错误 banner;不发 `Exited` —— 因为子进程 / 远端 shell 根本
    /// 没起来,语义上不是"退出"而是"从未开始"。
    ///
    /// 不复用 `Exited` 的理由:`Exited` 的 wire 形状是 `{ status: { code, signal } }`,
    /// 跟"远端 unreachable" / "auth failed" 的可读信息搭不上;前端处理逻辑
    /// (autotest / 命令计数)也按"已经跑过命令"假设,塞这里只会出 bug。
    SessionError { seq: u64, reason: String },
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

fn is_false(b: &bool) -> bool {
    !*b
}

fn is_default_fg(c: &Color) -> bool {
    matches!(c, Color::Named(NamedColor::Foreground))
}

fn is_default_bg(c: &Color) -> bool {
    matches!(c, Color::Named(NamedColor::Background))
}
