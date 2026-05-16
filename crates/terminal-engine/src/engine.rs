//! `TerminalEngine`:本 crate 的对外入口。
//!
//! 拆三件事:
//! 1. 把 PTY 字节流过 `vte::Parser` 喂给 `alacritty_terminal::Term`,让它
//!    维护 grid / 光标 / mode。
//! 2. 把 alacritty 内部的 cell / 颜色 / 光标类型翻成我们自己的 `Snapshot`。
//! 3. 把 listener 捕到的副作用(PTY 写回、标题)透传给上层。

use std::sync::Arc;

use alacritty_terminal::term::cell::{Cell as AlacrittyCell, Flags};
use alacritty_terminal::term::Config;
use alacritty_terminal::vte::ansi::{
    Color as AlacrittyColor, CursorShape, NamedColor as AlacrittyNamed,
};
use alacritty_terminal::Term;
use parking_lot::Mutex;
use vte::ansi::Processor;

use crate::listener::{CaptureListener, ListenerState};
use crate::modes::TerminalModes;
use crate::size::{AlacrittyDims, TerminalSize};
use crate::snapshot::{
    Cell, CellAttrs, CellWidth, Color, Cursor, CursorStyle, NamedColor, Row, Snapshot,
};

pub struct TerminalEngine {
    /// vte 上层 processor:维护 BSU(synchronized update)等高级状态机,
    /// 并把字节流翻成 `Handler` 方法调用,`Term` 已经实现 `Handler`。
    processor: Processor,
    term: Term<CaptureListener>,
    state: Arc<Mutex<ListenerState>>,
    size: TerminalSize,
}

impl TerminalEngine {
    pub fn new(size: TerminalSize) -> Self {
        let state = Arc::new(Mutex::new(ListenerState::default()));
        let listener = CaptureListener::new(Arc::clone(&state));
        let dims = AlacrittyDims::from(size);
        let term = Term::new(Config::default(), &dims, listener);
        Self {
            processor: Processor::new(),
            term,
            state,
            size,
        }
    }

    /// 喂一段 PTY 字节给状态机。可增量调用。
    pub fn feed(&mut self, bytes: &[u8]) {
        self.processor.advance(&mut self.term, bytes);
    }

    /// 改 grid 尺寸。和 PTY 自己的 resize 是独立动作 —— 调用方两边都要发。
    pub fn resize(&mut self, size: TerminalSize) {
        self.term.resize(AlacrittyDims::from(size));
        self.size = size;
    }

    /// 当前 grid + 光标 + 尺寸的完整快照。每次新分配 `Vec<Row>`。
    pub fn snapshot(&self) -> Snapshot {
        let rc = self.term.renderable_content();
        let display_offset = rc.display_offset as i32;
        let rows_count = self.size.rows as usize;
        let cols_count = self.size.cols as usize;

        // 预分配每一行,后面按 viewport line 索引放进去。每个 cell 都新构造
        // 是因为 Cell 不再 Copy(combining: Vec<char>),`vec![..; n]` 不再适用。
        let mut rows: Vec<Row> = (0..rows_count)
            .map(|_| Row {
                cells: std::iter::repeat_with(blank_cell)
                    .take(cols_count)
                    .collect(),
            })
            .collect();

        for indexed in rc.display_iter {
            let viewport_line = indexed.point.line.0 + display_offset;
            let col = indexed.point.column.0;
            // display_iter 理论上只给我们 0..rows × 0..cols,但稳一手:越界
            // 的 cell 静默丢弃,grid 已用空白预填,不影响其他位置。
            if viewport_line < 0 || (viewport_line as usize) >= rows_count {
                continue;
            }
            if col >= cols_count {
                continue;
            }
            rows[viewport_line as usize].cells[col] = translate_cell(indexed.cell);
        }

        let cursor = translate_cursor(rc.cursor, display_offset);
        Snapshot {
            size: self.size,
            cursor,
            rows,
        }
    }

    /// 当前 modes 视图(alt screen / app cursor / bracketed paste / mouse)。
    pub fn modes(&self) -> TerminalModes {
        TerminalModes::from_term_mode(*self.term.mode())
    }

    /// 取走终端要写回 PTY 的字节(DSR / DA / cursor position report 等)。
    /// **必须**有人定期 drain 并把它们写回 PTY,否则会让一些 TUI 应用 hang。
    pub fn drain_pending_writes(&mut self) -> Vec<Vec<u8>> {
        let mut s = self.state.lock();
        s.pending_writes.drain(..).collect()
    }

    /// 当前 OSC 0/2 设置的标题。
    pub fn title(&self) -> Option<String> {
        self.state.lock().title.clone()
    }
}

fn blank_cell() -> Cell {
    Cell {
        ch: ' ',
        combining: Vec::new(),
        width: CellWidth::Single,
        fg: Color::Named(NamedColor::Foreground),
        bg: Color::Named(NamedColor::Background),
        attrs: CellAttrs::empty(),
    }
}

fn translate_cell(cell: &AlacrittyCell) -> Cell {
    // alacritty 在 cell.extra.zerowidth 里挂组合字符 / variation selectors /
    // ZWJ 序列;只读 cell.c 会让 `e\u{301}` 退化成裸 `e`,emoji ZWJ 也会丢。
    let combining = cell.zerowidth().map(<[char]>::to_vec).unwrap_or_default();
    Cell {
        ch: cell.c,
        combining,
        width: width_from_flags(cell.flags),
        fg: translate_color(cell.fg),
        bg: translate_color(cell.bg),
        attrs: attrs_from_flags(cell.flags),
    }
}

fn width_from_flags(flags: Flags) -> CellWidth {
    if flags.contains(Flags::WIDE_CHAR) {
        CellWidth::Wide
    } else if flags.contains(Flags::WIDE_CHAR_SPACER) {
        CellWidth::WideSpacer
    } else {
        CellWidth::Single
    }
}

fn attrs_from_flags(flags: Flags) -> CellAttrs {
    let mut a = CellAttrs::empty();
    if flags.contains(Flags::BOLD) {
        a |= CellAttrs::BOLD;
    }
    if flags.contains(Flags::DIM) {
        a |= CellAttrs::DIM;
    }
    if flags.contains(Flags::ITALIC) {
        a |= CellAttrs::ITALIC;
    }
    // 折叠所有 underline 变体(double / curly / dotted / dashed)成单一 UNDERLINE
    // 标志。前端真要区分时再细分。
    if flags.intersects(Flags::ALL_UNDERLINES) {
        a |= CellAttrs::UNDERLINE;
    }
    if flags.contains(Flags::INVERSE) {
        a |= CellAttrs::REVERSE;
    }
    if flags.contains(Flags::HIDDEN) {
        a |= CellAttrs::HIDDEN;
    }
    if flags.contains(Flags::STRIKEOUT) {
        a |= CellAttrs::STRIKETHROUGH;
    }
    a
}

fn translate_color(color: AlacrittyColor) -> Color {
    match color {
        AlacrittyColor::Named(name) => Color::Named(translate_named(name)),
        AlacrittyColor::Spec(rgb) => Color::Rgb {
            r: rgb.r,
            g: rgb.g,
            b: rgb.b,
        },
        AlacrittyColor::Indexed(idx) => Color::Indexed(idx),
    }
}

fn translate_named(name: AlacrittyNamed) -> NamedColor {
    match name {
        AlacrittyNamed::Black => NamedColor::Black,
        AlacrittyNamed::Red => NamedColor::Red,
        AlacrittyNamed::Green => NamedColor::Green,
        AlacrittyNamed::Yellow => NamedColor::Yellow,
        AlacrittyNamed::Blue => NamedColor::Blue,
        AlacrittyNamed::Magenta => NamedColor::Magenta,
        AlacrittyNamed::Cyan => NamedColor::Cyan,
        AlacrittyNamed::White => NamedColor::White,
        AlacrittyNamed::BrightBlack => NamedColor::BrightBlack,
        AlacrittyNamed::BrightRed => NamedColor::BrightRed,
        AlacrittyNamed::BrightGreen => NamedColor::BrightGreen,
        AlacrittyNamed::BrightYellow => NamedColor::BrightYellow,
        AlacrittyNamed::BrightBlue => NamedColor::BrightBlue,
        AlacrittyNamed::BrightMagenta => NamedColor::BrightMagenta,
        AlacrittyNamed::BrightCyan => NamedColor::BrightCyan,
        AlacrittyNamed::BrightWhite => NamedColor::BrightWhite,
        AlacrittyNamed::Foreground => NamedColor::Foreground,
        AlacrittyNamed::Background => NamedColor::Background,
        AlacrittyNamed::Cursor => NamedColor::Cursor,
        AlacrittyNamed::DimBlack => NamedColor::DimBlack,
        AlacrittyNamed::DimRed => NamedColor::DimRed,
        AlacrittyNamed::DimGreen => NamedColor::DimGreen,
        AlacrittyNamed::DimYellow => NamedColor::DimYellow,
        AlacrittyNamed::DimBlue => NamedColor::DimBlue,
        AlacrittyNamed::DimMagenta => NamedColor::DimMagenta,
        AlacrittyNamed::DimCyan => NamedColor::DimCyan,
        AlacrittyNamed::DimWhite => NamedColor::DimWhite,
        AlacrittyNamed::BrightForeground => NamedColor::BrightForeground,
        AlacrittyNamed::DimForeground => NamedColor::DimForeground,
    }
}

fn translate_cursor(
    cursor: alacritty_terminal::term::RenderableCursor,
    display_offset: i32,
) -> Cursor {
    let viewport_line = cursor.point.line.0 + display_offset;
    let visible = !matches!(cursor.shape, CursorShape::Hidden);
    let style = match cursor.shape {
        CursorShape::Block | CursorShape::HollowBlock => CursorStyle::Block,
        CursorShape::Underline => CursorStyle::Underline,
        CursorShape::Beam => CursorStyle::Beam,
        CursorShape::Hidden => CursorStyle::Hidden,
    };
    // 越界(scrollback 视野外)就钳到 0;终端正常使用不会触发,scrollback
    // 模式下的精确光标是后续 scrollback API 的事。
    let row = if viewport_line < 0 {
        0
    } else {
        viewport_line as u16
    };
    Cursor {
        row,
        col: cursor.point.column.0 as u16,
        visible,
        style,
    }
}
