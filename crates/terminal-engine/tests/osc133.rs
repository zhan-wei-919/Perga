//! OSC 133 + 滚动追踪的全栈引擎测试:喂合成字节流,验证 `drain_command_ends`
//! 的命令结束标记、`take_scrolled_rows` 的滚出行、`scrollback_cleared`、
//! resize / alt-screen 降级。

use terminal_engine::{Row, TerminalEngine, TerminalSize};

/// 构造一条 `OSC 133 ; <body> ST` 序列。
fn osc133(body: &str) -> String {
    format!("\x1b]133;{body}\x1b\\")
}

fn row_text(row: &Row) -> String {
    row.cells
        .iter()
        .map(|c| c.ch)
        .collect::<String>()
        .trim_end()
        .to_string()
}

fn texts(rows: &[Row]) -> Vec<String> {
    rows.iter().map(row_text).collect()
}

#[test]
fn single_command_yields_one_mark() {
    let mut e = TerminalEngine::new(TerminalSize::new(10, 40));
    let stream = format!(
        "{}$ echo hi\r\n{}hi\r\n{}",
        osc133("A"),
        osc133("C"),
        osc133("D;0"),
    );
    e.feed(stream.as_bytes());
    let marks = e.drain_command_ends();
    assert_eq!(marks.len(), 1);
    assert_eq!(marks[0].exit, Some(0));
    // `$ echo hi` 在第 0 行;C 落在第 1 行,line = C 行 - 1。
    assert_eq!(marks[0].line, 0);
}

#[test]
fn multiple_commands_in_one_feed() {
    let mut e = TerminalEngine::new(TerminalSize::new(10, 40));
    let stream = format!(
        "{a}$ a\r\n{c}o1\r\n{d0}{a}$ b\r\n{c}o2\r\n{d1}",
        a = osc133("A"),
        c = osc133("C"),
        d0 = osc133("D;0"),
        d1 = osc133("D;1"),
    );
    e.feed(stream.as_bytes());
    let marks = e.drain_command_ends();
    assert_eq!(marks.len(), 2);
    assert_eq!((marks[0].line, marks[0].exit), (0, Some(0)));
    assert_eq!((marks[1].line, marks[1].exit), (2, Some(1)));
}

#[test]
fn exit_codes_passed_through() {
    for (body, want) in [
        ("D;0", Some(0)),
        ("D;1", Some(1)),
        ("D;130", Some(130)),
        ("D", None),
    ] {
        let mut e = TerminalEngine::new(TerminalSize::new(10, 40));
        e.feed(format!("{}$ c\r\n{}{}", osc133("A"), osc133("C"), osc133(body)).as_bytes());
        let marks = e.drain_command_ends();
        assert_eq!(marks.len(), 1, "body={body}");
        assert_eq!(marks[0].exit, want, "body={body}");
    }
}

#[test]
fn resize_mid_command_drops_inflight() {
    let mut e = TerminalEngine::new(TerminalSize::new(10, 40));
    e.feed(format!("{}$ x\r\n{}", osc133("A"), osc133("C")).as_bytes());
    e.resize(TerminalSize::new(12, 50));
    e.feed(osc133("D;0").as_bytes());
    // resize 重新基准化丢了在途命令,D 找不到 C → 不成标记。
    assert!(e.drain_command_ends().is_empty());
}

#[test]
fn marks_inside_alt_screen_do_not_form() {
    let mut e = TerminalEngine::new(TerminalSize::new(10, 40));
    let stream = format!(
        "\x1b[?1049h{}$ junk\r\n{}junkout\r\n{}\x1b[?1049l",
        osc133("A"),
        osc133("C"),
        osc133("D;0"),
    );
    e.feed(stream.as_bytes());
    assert!(
        e.drain_command_ends().is_empty(),
        "alt-screen 里的命令不该成标记"
    );
}

#[test]
fn command_crossing_alt_screen_within_one_chunk_drops() {
    let mut e = TerminalEngine::new(TerminalSize::new(10, 40));
    let stream = format!(
        "{}$ vimish\r\n{}\x1b[?1049hfullscreen\x1b[?1049l{}",
        osc133("A"),
        osc133("C"),
        osc133("D;0"),
    );
    e.feed(stream.as_bytes());
    assert!(
        e.drain_command_ends().is_empty(),
        "穿过 alt-screen 的命令不该成标记"
    );
}

#[test]
fn osc_mark_split_across_feeds() {
    // OSC 133;C 跨两次 feed —— 旁路解析器的字节级状态必须连续。
    let mut e = TerminalEngine::new(TerminalSize::new(10, 40));
    e.feed(format!("{}$ s\r\n", osc133("A")).as_bytes());
    e.feed(b"\x1b]133;C"); // C 的前半,无终止符
    e.feed(b"\x1b\\out\r\n"); // C 的后半 + 输出
    e.feed(osc133("D;0").as_bytes());
    assert_eq!(e.drain_command_ends().len(), 1);
}

#[test]
fn scrolled_rows_captured_in_order() {
    let mut e = TerminalEngine::new(TerminalSize::new(5, 20));
    // 5 行屏,喂 5 行(每行 \r\n)→ 第 5 个 \r\n 把第 0 行滚出顶部。
    e.feed(b"L0\r\nL1\r\nL2\r\nL3\r\nL4\r\n");
    assert_eq!(texts(&e.take_scrolled_rows()), ["L0"]);
    // 再喂 2 行 → 滚出 L1 / L2,chronological 顺序。
    e.feed(b"L5\r\nL6\r\n");
    assert_eq!(texts(&e.take_scrolled_rows()), ["L1", "L2"]);
}

#[test]
fn take_scrolled_rows_empty_without_scroll() {
    let mut e = TerminalEngine::new(TerminalSize::new(10, 40));
    e.feed(b"just one line\r\n");
    assert!(e.take_scrolled_rows().is_empty());
}

#[test]
fn clearing_scrollback_sets_cleared_flag() {
    let mut e = TerminalEngine::new(TerminalSize::new(5, 20));
    for i in 0..15 {
        e.feed(format!("L{i:02}\r\n").as_bytes());
    }
    e.feed(b"\x1b[3J"); // erase saved lines
    assert!(e.scrollback_cleared(), "CSI 3J 应触发 scrollback_cleared");
    assert!(e.take_scrolled_rows().is_empty(), "清空帧不带滚出行");
    // 后续 feed 不再报 cleared。
    e.feed(b"more\r\n");
    assert!(!e.scrollback_cleared());
}

#[test]
fn alt_screen_freezes_scroll() {
    // 进 alt-screen 跑满屏输出 —— alt 屏无 scrollback,不能误报滚动 / 清空。
    let mut e = TerminalEngine::new(TerminalSize::new(5, 20));
    e.feed(b"a\r\nb\r\nc\r\n");
    let _ = e.take_scrolled_rows();
    e.feed(b"\x1b[?1049h");
    assert!(
        !e.scrollback_cleared(),
        "进 alt-screen 不算 scrollback 清空"
    );
    for i in 0..20 {
        e.feed(format!("alt{i}\r\n").as_bytes());
    }
    assert!(
        e.take_scrolled_rows().is_empty(),
        "alt-screen 期间不产生滚出行"
    );
    e.feed(b"\x1b[?1049l");
}
