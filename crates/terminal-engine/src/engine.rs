//! `TerminalEngine`:本 crate 的对外入口。
//!
//! 拆三件事:
//! 1. 把 PTY 字节流过 `vte::Parser` 喂给 `alacritty_terminal::Term`,让它
//!    维护 grid / 光标 / mode。
//! 2. 把 alacritty 内部的 cell / 颜色 / 光标类型翻成我们自己的 `Snapshot`。
//! 3. 把 listener 捕到的副作用(PTY 写回、标题)透传给上层。

use std::sync::Arc;

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::Line;
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
use crate::shell_integration::ShellIntegration;
use transport::TerminalSize;

use crate::size::AlacrittyDims;
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
    /// 旁路 OSC 133 解析 —— 与 `processor` 吃同一份字节,抽命令边界。
    shell: ShellIntegration,
    /// 滚出视口顶部的累计行数。`scroll_total + 视口行` = 跨滚动稳定的绝对行号。
    /// resize / `CSI 3J` 时归零。
    scroll_total: u64,
    /// 本次 `feed` 内滚出 viewport 顶的行数,`feed` 开头清零。session 据此从
    /// scrollback 取出这些行塞进 patch。
    pending_scrolled: u64,
    /// 本次 `feed` 内是否发生 scrollback 清空(`CSI 3J`),`feed` 开头清零。
    scrollback_cleared_this_feed: bool,
}

/// 一条跑完的命令的标记 —— 命令输入行的绝对行号 + 退出码。
/// session 层据此编码 `CommandEnd` 协议事件。
pub struct CommandMark {
    /// 命令输入行(`$ cmd` 那一行)的绝对行号。
    pub line: u64,
    /// 退出码;shell 没带或解析失败时 `None`。
    pub exit: Option<i32>,
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
            shell: ShellIntegration::new(),
            scroll_total: 0,
            pending_scrolled: 0,
            scrollback_cleared_this_feed: false,
        }
    }

    /// 喂一段 PTY 字节给状态机。可增量调用。
    ///
    /// 旁路 OSC 133 解析器与 alacritty 吃同一份字节;含 OSC 133 标记时,按标记
    /// 的字节偏移把 chunk 切段交错喂 alacritty,在每个标记处采样光标得到绝对
    /// 行号 —— 光标行是视口相对坐标、滚动即失效,必须当场采。
    pub fn feed(&mut self, bytes: &[u8]) {
        self.pending_scrolled = 0;
        self.scrollback_cleared_this_feed = false;
        let points = self.shell.scan_segment(bytes);
        let mut start = 0;
        // 逐切点推进 alacritty。切点 = OSC 133 标记,或 alt-screen 进入序列。
        // 在每个切点按**当时**的 alt-screen 状态决定标记处理:正常态 → 采光标
        // resolve;alt-screen 态 → skip(TUI 里的 133 无命令块语义)。
        // alt-screen 进入序列本身也是切点 —— 保证「同一 chunk 内进出 alt-screen」
        // 的 mode 转换不会被整段跳过,否则穿过 alt-screen 的命令会假成块。
        let mut alt = self.is_alt_screen();
        for point in points {
            self.advance_alacritty(&bytes[start..point.offset]);
            let alt_now = self.is_alt_screen();
            if alt_now && !alt {
                // 进入 alt-screen:在途命令无法干净成块,丢弃。
                self.shell.reset();
            }
            alt = alt_now;
            if point.is_mark {
                if alt {
                    self.shell.skip_pending();
                } else {
                    let line = self.cursor_line();
                    self.shell.resolve_pending(self.scroll_total + line);
                }
            }
            start = point.offset;
        }
        self.advance_alacritty(&bytes[start..]);
        // 末段(无切点的纯切换 chunk)也可能进 alt-screen。
        if self.is_alt_screen() && !alt {
            self.shell.reset();
        }
    }

    /// 改 grid 尺寸。和 PTY 自己的 resize 是独立动作 —— 调用方两边都要发。
    ///
    /// reflow 会让绝对行号失真,所以这里重新基准化:`scroll_total` 归零、丢弃
    /// 在途命令。前端已累积的 history 保留(旧宽度,不 reflow)。
    pub fn resize(&mut self, size: TerminalSize) {
        self.term.resize(AlacrittyDims::from(size));
        self.size = size;
        self.scroll_total = 0;
        self.shell.reset();
    }

    /// 当前 viewport grid + 光标 + 尺寸的完整快照。每次新分配 `Vec<Row>`。
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

    /// 取 grid 上 `grid_line` 行(可负 = scrollback)的内容。
    ///
    /// `grid_line` 必须落在 `[topmost_line, bottommost_line]`;越界说明该行已
    /// 滚出保留的 scrollback —— 钳回边界、返回空白行并 warn,不 panic。
    /// (alacritty 的 grid 索引越界在 debug 构建会 panic,所以这里先钳。)
    fn translate_grid_row(&self, grid_line: i32) -> Row {
        let top = self.term.topmost_line().0;
        let bottom = self.term.bottommost_line().0;
        let clamped = grid_line.clamp(top, bottom);
        if clamped != grid_line {
            tracing::warn!(
                requested = grid_line,
                top,
                bottom,
                "engine.grid_row_out_of_scrollback"
            );
            return Row {
                cells: std::iter::repeat_with(blank_cell)
                    .take(self.size.cols as usize)
                    .collect(),
            };
        }
        let cells = self.term.grid()[Line(clamped)][..]
            .iter()
            .map(translate_cell)
            .collect();
        Row { cells }
    }

    /// 取走自上次调用以来跑完的命令标记。在 `feed` 之后调用。
    pub fn drain_command_ends(&mut self) -> Vec<CommandMark> {
        self.shell
            .drain_regions()
            .into_iter()
            .map(|r| CommandMark {
                line: r.line,
                exit: r.exit,
            })
            .collect()
    }

    /// 取走本次 `feed` 从 viewport 顶滚出、进入 scrollback 的行(chronological,
    /// 最早滚出在前)。session 把它塞进 patch 的 `scrolled_rows`,前端 append
    /// 进自己的 history buffer。
    ///
    /// 本帧 scrollback 被清(`CSI 3J`)时返回空 —— 那些行已不可读,前端会按
    /// [`Self::scrollback_cleared`] 清空 history。
    pub fn take_scrolled_rows(&mut self) -> Vec<Row> {
        let n = std::mem::take(&mut self.pending_scrolled);
        if self.scrollback_cleared_this_feed || n == 0 {
            return Vec::new();
        }
        let n = n as i32;
        (-n..0).map(|gl| self.translate_grid_row(gl)).collect()
    }

    /// 本次 `feed` 内是否发生了 scrollback 清空(`CSI 3J` / `clear`)。
    pub fn scrollback_cleared(&self) -> bool {
        self.scrollback_cleared_this_feed
    }

    /// 把一段字节喂给 alacritty,并按 `history_size` 增量推进 `scroll_total`
    /// 与本帧 `pending_scrolled`。
    ///
    /// alt-screen 没有 scrollback;整段在 alt-screen、或本段跨越 alt-screen
    /// 进出切换时,`history_size` 的跳变是备用屏切换、不是真实滚动 —— 跳过
    /// 增量计算,`scroll_total` 在 alt-screen 期间冻结。
    fn advance_alacritty(&mut self, segment: &[u8]) {
        let alt_before = self.is_alt_screen();
        let before = self.term.history_size();
        self.processor.advance(&mut self.term, segment);
        let after = self.term.history_size();
        if alt_before || self.is_alt_screen() {
            return;
        }
        if after >= before {
            let delta = (after - before) as u64;
            self.scroll_total += delta;
            self.pending_scrolled += delta;
        } else {
            // history_size 回落 = scrollback 被清(CSI 3J / `clear`)。绝对
            // 行号坐标系失真 —— 重新基准化,丢掉在途命令。
            self.scroll_total = 0;
            self.pending_scrolled = 0;
            self.scrollback_cleared_this_feed = true;
            self.shell.reset();
        }
    }

    /// 当前光标的视口行(`>= 0`)。
    fn cursor_line(&self) -> u64 {
        let cursor = self.term.renderable_content().cursor;
        cursor.point.line.0.max(0) as u64
    }

    fn is_alt_screen(&self) -> bool {
        self.modes().alt_screen
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

#[cfg(test)]
mod tests {
    use super::*;

    fn row_text(row: &Row) -> String {
        row.cells
            .iter()
            .map(|c| c.ch)
            .collect::<String>()
            .trim_end()
            .to_string()
    }

    #[test]
    fn translate_grid_row_reads_viewport() {
        let mut engine = TerminalEngine::new(TerminalSize::new(5, 20));
        engine.feed(b"AAA\r\nBBB\r\nCCC");
        assert_eq!(row_text(&engine.translate_grid_row(0)), "AAA");
        assert_eq!(row_text(&engine.translate_grid_row(1)), "BBB");
        assert_eq!(row_text(&engine.translate_grid_row(2)), "CCC");
        // 越界(无 scrollback 时负行号 / 超底)→ 钳 → 空白行。
        assert!(row_text(&engine.translate_grid_row(-100)).is_empty());
        assert!(row_text(&engine.translate_grid_row(100)).is_empty());
    }

    #[test]
    fn translate_grid_row_reads_scrollback() {
        let mut engine = TerminalEngine::new(TerminalSize::new(5, 20));
        for i in 0..20 {
            engine.feed(format!("L{i:02}\r\n").as_bytes());
        }
        // 顶部多行已滚进 scrollback,负 grid_line 可取到。
        let line = engine.translate_grid_row(-1);
        assert!(
            row_text(&line).starts_with('L'),
            "scrollback 行应有内容,实际 {:?}",
            row_text(&line)
        );
        // 远超保留的 scrollback → 钳 → 空白行。
        assert!(row_text(&engine.translate_grid_row(-100_000)).is_empty());
    }
}
