//! `terminal-engine` 集成测试。
//!
//! 每个测试独立 `TerminalEngine::new`,喂一小段字节,验证 grid / mode /
//! cursor / listener 状态。**不**碰 `alacritty_terminal` 内部类型,只用本
//! crate 公开 API,这样契约一变就能立刻被打到。

use terminal_engine::{CellWidth, MouseReporting, TerminalEngine, TerminalSize};

fn engine_24x80() -> TerminalEngine {
    TerminalEngine::new(TerminalSize::new(24, 80))
}

/// 把第 row 行的 cell 字符顺序拼成 String,trim 掉尾部空格便于断言。
fn row_text_trimmed(engine: &TerminalEngine, row: usize) -> String {
    let snap = engine.snapshot();
    let s: String = snap.rows[row].cells.iter().map(|c| c.ch).collect();
    s.trim_end().to_string()
}

#[test]
fn plain_text_to_grid() {
    let mut e = engine_24x80();
    e.feed(b"hello");
    let snap = e.snapshot();
    let row0: Vec<char> = snap.rows[0].cells.iter().map(|c| c.ch).collect();
    assert_eq!(&row0[..5], &['h', 'e', 'l', 'l', 'o']);
    assert!(row0[5..].iter().all(|c| *c == ' '));
    assert_eq!(snap.cursor.row, 0);
    assert_eq!(snap.cursor.col, 5);
}

#[test]
fn newline_advances_row() {
    let mut e = engine_24x80();
    e.feed(b"hello\r\nworld");
    assert_eq!(row_text_trimmed(&e, 0), "hello");
    assert_eq!(row_text_trimmed(&e, 1), "world");
}

#[test]
fn clear_screen() {
    let mut e = engine_24x80();
    e.feed(b"junk text on screen\r\nmore junk");
    e.feed(b"\x1b[2J");
    let snap = e.snapshot();
    for (i, row) in snap.rows.iter().enumerate() {
        assert!(
            row.cells.iter().all(|c| c.ch == ' '),
            "row {i} should be blank after \\x1b[2J, got {:?}",
            row.cells.iter().map(|c| c.ch).collect::<String>()
        );
    }
}

#[test]
fn alt_screen_mode() {
    let mut e = engine_24x80();
    assert!(!e.modes().alt_screen);
    e.feed(b"\x1b[?1049h");
    assert!(e.modes().alt_screen);
    e.feed(b"\x1b[?1049l");
    assert!(!e.modes().alt_screen);
}

#[test]
fn app_cursor_mode() {
    let mut e = engine_24x80();
    assert!(!e.modes().app_cursor);
    e.feed(b"\x1b[?1h");
    assert!(e.modes().app_cursor);
    e.feed(b"\x1b[?1l");
    assert!(!e.modes().app_cursor);
}

#[test]
fn bracketed_paste_mode() {
    let mut e = engine_24x80();
    assert!(!e.modes().bracketed_paste);
    e.feed(b"\x1b[?2004h");
    assert!(e.modes().bracketed_paste);
    e.feed(b"\x1b[?2004l");
    assert!(!e.modes().bracketed_paste);
}

#[test]
fn mouse_reporting_progressions() {
    let mut e = engine_24x80();
    assert_eq!(e.modes().mouse_reporting, MouseReporting::Off);
    e.feed(b"\x1b[?1000h");
    assert_eq!(e.modes().mouse_reporting, MouseReporting::Normal);
    e.feed(b"\x1b[?1002h");
    assert_eq!(e.modes().mouse_reporting, MouseReporting::Button);
    e.feed(b"\x1b[?1003h");
    assert_eq!(e.modes().mouse_reporting, MouseReporting::Any);
    e.feed(b"\x1b[?1003l\x1b[?1002l\x1b[?1000l");
    assert_eq!(e.modes().mouse_reporting, MouseReporting::Off);
}

#[test]
fn resize_changes_dimensions() {
    let mut e = engine_24x80();
    let snap0 = e.snapshot();
    assert_eq!(snap0.size, TerminalSize::new(24, 80));
    assert_eq!(snap0.rows.len(), 24);
    assert_eq!(snap0.rows[0].cells.len(), 80);

    e.resize(TerminalSize::new(40, 120));
    let snap1 = e.snapshot();
    assert_eq!(snap1.size, TerminalSize::new(40, 120));
    assert_eq!(snap1.rows.len(), 40);
    assert_eq!(snap1.rows[0].cells.len(), 120);
}

/// 关键测试:终端通过 listener 要求写回 PTY 的字节必须能 drain 出来。
/// 没这条路径,vim / less 等 TUI 应用会卡在等 CPR / DA 响应上。
#[test]
fn dsr_emits_pty_write() {
    let mut e = engine_24x80();
    // CSI 6 n = Cursor Position Report 请求。期望响应类似 \x1b[1;1R。
    e.feed(b"\x1b[6n");
    let writes = e.drain_pending_writes();
    assert!(!writes.is_empty(), "CPR should produce a pending PTY write");
    let combined: Vec<u8> = writes.into_iter().flatten().collect();
    assert!(
        combined.starts_with(b"\x1b["),
        "CPR response should start with CSI, got {:?}",
        String::from_utf8_lossy(&combined)
    );
    assert!(
        combined.ends_with(b"R"),
        "CPR response should end with 'R', got {:?}",
        String::from_utf8_lossy(&combined)
    );
}

#[test]
fn osc_sets_title() {
    let mut e = engine_24x80();
    assert!(e.title().is_none());
    // OSC 2 ; mytitle BEL
    e.feed(b"\x1b]2;mytitle\x07");
    assert_eq!(e.title().as_deref(), Some("mytitle"));
}

/// Regression:组合字符必须随主字符放在同一个 cell 里。之前 `translate_cell`
/// 只复制 `cell.c`,`e\u{301}` 会退化成裸 `e`,前端拿到的 grid 是损坏的。
#[test]
fn combining_mark_preserved_in_same_cell() {
    let mut e = engine_24x80();
    // 'e' (U+0065) + COMBINING ACUTE ACCENT (U+0301) = "é" 的 NFD 形态。
    e.feed("e\u{301}".as_bytes());
    let snap = e.snapshot();
    let cell = &snap.rows[0].cells[0];
    assert_eq!(cell.ch, 'e');
    assert_eq!(
        cell.combining,
        vec!['\u{301}'],
        "combining mark must be captured into Cell.combining"
    );
    assert_eq!(cell.glyph(), "e\u{301}");
    // 组合字符是 zero-width,光标只走了一格。
    assert_eq!(snap.cursor.col, 1);
    // 第二个 cell 没被组合字符污染。
    assert_eq!(snap.rows[0].cells[1].ch, ' ');
    assert!(snap.rows[0].cells[1].combining.is_empty());
}

/// Regression(emoji ZWJ):零宽连接符 + 后续 codepoint 也走 zerowidth 路径,
/// `Cell.combining` 要能容纳多个 codepoint。这里用 family 序列「👨‍👩‍👧」
/// 验证 alacritty 把 ZWJ + 后续 emoji 累积到首格的 zerowidth 里。
///
/// 注意:这一层**不**渲染合体 emoji。我们只验证 codepoint 全部保留下来,
/// 渲染合并是前端 Grid Renderer 的事。
#[test]
fn emoji_zwj_codepoints_preserved() {
    let mut e = engine_24x80();
    // 👨 U+1F468(Wide) + ZWJ U+200D(zerowidth) + 👩 U+1F469(...)
    // + ZWJ + 👧 U+1F467
    e.feed("\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}".as_bytes());
    let snap = e.snapshot();
    let glyph0 = snap.rows[0].cells[0].glyph();
    // 起始 cell 必须至少包含 U+1F468 + 一个 ZWJ;具体哪些 codepoint 落在
    // 哪个 cell 取决于 alacritty 的处理,但 ZWJ 一定不能丢。
    assert!(
        glyph0.contains('\u{1F468}'),
        "first cell must contain 👨 (U+1F468), got {glyph0:?}"
    );
    assert!(
        glyph0.contains('\u{200D}'),
        "first cell must keep ZWJ (U+200D) as a combining codepoint, got {glyph0:?}"
    );
}

#[test]
fn cjk_double_width() {
    let mut e = engine_24x80();
    e.feed("你好".as_bytes());
    let snap = e.snapshot();
    let row0 = &snap.rows[0].cells;
    assert_eq!(row0[0].ch, '你');
    assert_eq!(row0[0].width, CellWidth::Wide);
    assert_eq!(row0[1].width, CellWidth::WideSpacer);
    assert_eq!(row0[2].ch, '好');
    assert_eq!(row0[2].width, CellWidth::Wide);
    assert_eq!(row0[3].width, CellWidth::WideSpacer);
    // 光标停在第 4 列(2 个宽字符占 0..4)。
    assert_eq!(snap.cursor.col, 4);
}
