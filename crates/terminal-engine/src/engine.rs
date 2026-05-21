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
    /// 旁路 OSC 133 解析 —— 与 `processor` 吃同一份字节,抽命令块边界。
    shell: ShellIntegration,
    /// 滚出视口顶部的累计行数。`scroll_total + 视口行` = 跨滚动稳定的绝对行号。
    /// resize 时归零(reflow 让旧坐标失真),所以它是「自上次 resize 起」的计数。
    scroll_total: u64,
    /// 最近一个命令块的结束位置 `(绝对行, 列)`。`active_top` 据行算 Canvas
    /// 活动区起点;列 >0(命令输出无结尾换行)时 `snapshot` 把那一行已归命令
    /// 块的前缀列抹空,免得 Canvas 和命令块重复画同一行。
    last_block_end: Option<(u64, u16)>,
}

/// 一条跑完的命令,行内容已从 grid 取出。session 层据此编码 `CommandBlock` 事件。
pub struct ResolvedCommand {
    /// 退出码;shell 没带或解析失败时 `None`。
    pub exit: Option<i32>,
    /// 命令头(提示符 + 输入的命令行)各行;没收到 prompt-start 时为空。
    pub command_rows: Vec<Row>,
    /// 命令输出各行;无输出命令为空。
    pub output_rows: Vec<Row>,
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
            last_block_end: None,
        }
    }

    /// 喂一段 PTY 字节给状态机。可增量调用。
    ///
    /// 旁路 OSC 133 解析器与 alacritty 吃同一份字节;含 OSC 133 标记时,按标记
    /// 的字节偏移把 chunk 切段交错喂 alacritty,在每个标记处采样光标得到绝对
    /// 行号 —— 光标行是视口相对坐标、滚动即失效,必须当场采。
    pub fn feed(&mut self, bytes: &[u8]) {
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
                    let (line, col) = self.cursor_grid_pos();
                    self.shell.resolve_pending(self.scroll_total + line, col);
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
    /// 在途命令。已下发的命令块是前端冻结 DOM,不受影响。
    pub fn resize(&mut self, size: TerminalSize) {
        self.term.resize(AlacrittyDims::from(size));
        self.size = size;
        self.scroll_total = 0;
        self.last_block_end = None;
        self.shell.reset();
    }

    /// 当前 grid + 光标 + 尺寸的完整快照。每次新分配 `Vec<Row>`。
    ///
    /// 命令输出无结尾换行时,会把活动区起始行里已归命令块的前缀列抹空
    /// (见 [`mask_block_columns`])—— 这一层是「Canvas 该渲染什么」的视图,
    /// 不是裸 grid。
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
        let mut snapshot = Snapshot {
            size: self.size,
            cursor,
            rows,
        };
        self.mask_block_columns(&mut snapshot);
        snapshot
    }

    /// 把活动区起始行里**已归命令块**的前缀列抹成空白。
    ///
    /// 命令输出无结尾换行时,`D` 那一行被命令块(前缀列)和活动区(后缀列 ──
    /// 下一个 prompt)共用。命令块那半边已经进了 DOM,Canvas 渲染
    /// `[active_top, rows)` 时不该重复画 —— 在快照里把它抹空。
    fn mask_block_columns(&self, snapshot: &mut Snapshot) {
        if self.is_alt_screen() {
            return;
        }
        let Some((end_abs, end_col)) = self.last_block_end else {
            return;
        };
        if end_col == 0 {
            return;
        }
        let row = end_abs as i64 - self.scroll_total as i64;
        if row < 0 || row >= snapshot.rows.len() as i64 {
            return;
        }
        let cells = &mut snapshot.rows[row as usize].cells;
        let n = (end_col as usize).min(cells.len());
        for cell in &mut cells[..n] {
            *cell = blank_cell();
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

    /// 取走自上次调用以来跑完的命令,行内容已从 grid(含 scrollback)取出。
    ///
    /// 必须在 `feed` 之后、`active_top` 之前调用 —— session 事件循环保证这个
    /// 顺序,`active_top` 依赖本方法更新的 `last_block_end_abs`。
    pub fn drain_marks(&mut self) -> Vec<ResolvedCommand> {
        let regions = self.shell.drain_regions();
        let mut out = Vec::with_capacity(regions.len());
        for region in regions {
            let command_rows = self.header_rows(region.prompt, region.command_abs);
            let output_rows = self.output_rows(region.command_abs, region.end_abs, region.end_col);
            self.last_block_end = Some((region.end_abs, region.end_col));
            out.push(ResolvedCommand {
                exit: region.exit,
                command_rows,
                output_rows,
            });
        }
        out
    }

    /// Canvas 活动区(未被任何 block 收走的部分)在当前视口里的起始行。
    ///
    /// Canvas 只渲染 `[active_top, rows)`。无 block / alt-screen → 0(全屏)。
    pub fn active_top(&self) -> u16 {
        if self.is_alt_screen() {
            return 0;
        }
        let Some((end_abs, _)) = self.last_block_end else {
            return 0;
        };
        let viewport = end_abs as i64 - self.scroll_total as i64;
        viewport.clamp(0, self.size.rows as i64) as u16
    }

    /// 把绝对行区间 `[start, end)` 翻成当前 grid 的行内容。
    fn rows_for_abs_range(&self, start: u64, end: u64) -> Vec<Row> {
        if end <= start {
            return Vec::new();
        }
        (start..end)
            .map(|abs| {
                let grid_line = abs as i64 - self.scroll_total as i64;
                self.translate_grid_row(grid_line as i32)
            })
            .collect()
    }

    /// 命令头各行(提示符 + 输入的命令行)。首行从 prompt 的列起切 —— 上一条
    /// 无结尾换行的命令会让 `A` 落在非 0 列,否则会把上一条的残留带进来。
    fn header_rows(&self, prompt: Option<(u64, u16)>, command_abs: u64) -> Vec<Row> {
        let Some((prompt_abs, prompt_col)) = prompt else {
            return Vec::new();
        };
        let mut rows = self.rows_for_abs_range(prompt_abs, command_abs);
        if let Some(first) = rows.first_mut() {
            let drop = (prompt_col as usize).min(first.cells.len());
            first.cells.drain(..drop);
        }
        rows
    }

    /// 命令输出各行。`[command_abs, end_abs)` 的整行;`end_col > 0` 说明命令
    /// 输出无结尾换行(`C` 和 `D` 同行),把 `end_abs` 行截到 `end_col` 列补上。
    fn output_rows(&self, command_abs: u64, end_abs: u64, end_col: u16) -> Vec<Row> {
        let mut rows = self.rows_for_abs_range(command_abs, end_abs);
        if end_col > 0 {
            let grid_line = end_abs as i64 - self.scroll_total as i64;
            let mut last = self.translate_grid_row(grid_line as i32);
            last.cells.truncate(end_col as usize);
            rows.push(last);
        }
        rows
    }

    /// 把一段字节喂给 alacritty,并按 `history_size` 增量推进 `scroll_total`。
    fn advance_alacritty(&mut self, segment: &[u8]) {
        let before = self.term.history_size();
        self.processor.advance(&mut self.term, segment);
        let after = self.term.history_size();
        if after >= before {
            self.scroll_total += (after - before) as u64;
        } else {
            // history_size 回落 = scrollback 被清(CSI 3J / `clear`)。绝对
            // 行号坐标系失真 —— 同 resize 一样重新基准化,丢掉在途命令。
            self.scroll_total = 0;
            self.last_block_end = None;
            self.shell.reset();
        }
    }

    /// 当前光标的视口行(`>= 0`)与列。
    fn cursor_grid_pos(&self) -> (u64, u16) {
        let cursor = self.term.renderable_content().cursor;
        let line = cursor.point.line.0.max(0) as u64;
        let col = cursor.point.column.0 as u16;
        (line, col)
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
