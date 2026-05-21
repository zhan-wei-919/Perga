//! OSC 133 全栈引擎测试:喂含 OSC 133 的合成字节流,验证 `feed` 的交错采样、
//! `drain_marks` 的命令块组装、`active_top`、resize / alt-screen 降级。

use terminal_engine::{ResolvedCommand, Row, TerminalEngine, TerminalSize};

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

fn drain_one(e: &mut TerminalEngine) -> ResolvedCommand {
    let mut marks = e.drain_marks();
    assert_eq!(marks.len(), 1, "期望恰好一个命令块");
    marks.remove(0)
}

#[test]
fn single_line_command() {
    let mut e = TerminalEngine::new(TerminalSize::new(10, 40));
    let stream = format!(
        "{}$ echo hi\r\n{}hi\r\n{}",
        osc133("A"),
        osc133("C"),
        osc133("D;0"),
    );
    e.feed(stream.as_bytes());
    let cmd = drain_one(&mut e);
    assert_eq!(cmd.exit, Some(0));
    assert_eq!(texts(&cmd.command_rows), ["$ echo hi"]);
    assert_eq!(texts(&cmd.output_rows), ["hi"]);
    // 命令收尾后,活动区从下一行(end_abs)起。
    assert_eq!(e.active_top(), 2);
}

#[test]
fn multiline_output_spanning_scroll() {
    // 10 行屏,命令输出 30 行 —— probe 暴露的「超一屏丢行」回归点。
    let mut e = TerminalEngine::new(TerminalSize::new(10, 40));
    let mut stream = format!("{}$ run\r\n{}", osc133("A"), osc133("C"));
    for i in 0..30 {
        stream.push_str(&format!("out{i:02}\r\n"));
    }
    stream.push_str(&osc133("D;0"));
    e.feed(stream.as_bytes());
    let cmd = drain_one(&mut e);
    let out = texts(&cmd.output_rows);
    assert_eq!(out.len(), 30, "超一屏的输出不能丢行");
    assert_eq!(out[0], "out00");
    assert_eq!(out[29], "out29");
    // 命令头在 scrollback 里也要取得回。
    assert_eq!(texts(&cmd.command_rows), ["$ run"]);
}

#[test]
fn zero_output_command() {
    let mut e = TerminalEngine::new(TerminalSize::new(10, 40));
    let stream = format!("{}$ true\r\n{}{}", osc133("A"), osc133("C"), osc133("D;0"));
    e.feed(stream.as_bytes());
    let cmd = drain_one(&mut e);
    assert!(cmd.output_rows.is_empty(), "无输出命令的 output 应为空");
    assert_eq!(texts(&cmd.command_rows), ["$ true"]);
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
    let marks = e.drain_marks();
    assert_eq!(marks.len(), 2);
    assert_eq!(marks[0].exit, Some(0));
    assert_eq!(texts(&marks[0].output_rows), ["o1"]);
    assert_eq!(marks[1].exit, Some(1));
    assert_eq!(texts(&marks[1].output_rows), ["o2"]);
}

#[test]
fn resize_mid_command_drops_inflight() {
    let mut e = TerminalEngine::new(TerminalSize::new(10, 40));
    e.feed(format!("{}$ x\r\n{}", osc133("A"), osc133("C")).as_bytes());
    e.resize(TerminalSize::new(12, 50));
    e.feed(osc133("D;0").as_bytes());
    // resize 重新基准化丢了在途命令,D 找不到 C → 不成块。
    assert!(e.drain_marks().is_empty());
}

#[test]
fn alt_screen_suspends_then_resumes() {
    let mut e = TerminalEngine::new(TerminalSize::new(10, 40));
    // 进 alt-screen 后的 OSC 133 不成块。
    e.feed(b"\x1b[?1049h");
    e.feed(
        format!(
            "{}$ y\r\n{}o\r\n{}",
            osc133("A"),
            osc133("C"),
            osc133("D;0")
        )
        .as_bytes(),
    );
    assert!(e.drain_marks().is_empty());
    assert_eq!(e.active_top(), 0);
    // 退出 alt-screen 后恢复成块。
    e.feed(b"\x1b[?1049l");
    e.feed(
        format!(
            "{}$ z\r\n{}o\r\n{}",
            osc133("A"),
            osc133("C"),
            osc133("D;0")
        )
        .as_bytes(),
    );
    assert_eq!(e.drain_marks().len(), 1);
}

#[test]
fn active_top_zero_before_any_command() {
    let mut e = TerminalEngine::new(TerminalSize::new(10, 40));
    e.feed(b"plain output\r\n");
    assert_eq!(e.active_top(), 0);
}

#[test]
fn osc_mark_split_across_feeds() {
    // OSC 133;C 跨两次 feed —— 旁路解析器的字节级状态必须连续。
    let mut e = TerminalEngine::new(TerminalSize::new(10, 40));
    e.feed(format!("{}$ s\r\n", osc133("A")).as_bytes());
    e.feed(b"\x1b]133;C"); // C 的前半,无终止符
    e.feed(b"\x1b\\out\r\n"); // C 的后半 + 输出
    e.feed(osc133("D;0").as_bytes());
    let cmd = drain_one(&mut e);
    assert_eq!(texts(&cmd.output_rows), ["out"]);
    assert_eq!(texts(&cmd.command_rows), ["$ s"]);
}

#[test]
fn output_without_trailing_newline_is_captured() {
    // `printf hi` 无结尾换行 —— C 与 D 落在同一行,输出不能丢。
    let mut e = TerminalEngine::new(TerminalSize::new(10, 40));
    let stream = format!(
        "{}$ printf hi\r\n{}hi{}",
        osc133("A"),
        osc133("C"),
        osc133("D;0"),
    );
    e.feed(stream.as_bytes());
    let cmd = drain_one(&mut e);
    assert_eq!(texts(&cmd.output_rows), ["hi"], "无结尾换行的输出不能丢");
    assert_eq!(texts(&cmd.command_rows), ["$ printf hi"]);
}

#[test]
fn output_with_and_without_trailing_newline_mixed() {
    // 多行输出且最后一行无换行。
    let mut e = TerminalEngine::new(TerminalSize::new(10, 40));
    let stream = format!(
        "{}$ run\r\n{}a\r\nb\r\nc{}",
        osc133("A"),
        osc133("C"),
        osc133("D;0"),
    );
    e.feed(stream.as_bytes());
    let cmd = drain_one(&mut e);
    assert_eq!(texts(&cmd.output_rows), ["a", "b", "c"]);
}

#[test]
fn clearing_scrollback_does_not_panic() {
    // CSI 3J 清 scrollback 会让 history_size 回落;scroll_total 的增量计算
    // 不能下溢 panic,且后续命令仍能正常成块。
    let mut e = TerminalEngine::new(TerminalSize::new(5, 20));
    for i in 0..20 {
        e.feed(format!("L{i:02}\r\n").as_bytes());
    }
    e.feed(b"\x1b[3J"); // erase saved lines
    let stream = format!(
        "{}$ x\r\n{}out\r\n{}",
        osc133("A"),
        osc133("C"),
        osc133("D;0"),
    );
    e.feed(stream.as_bytes());
    let cmd = drain_one(&mut e);
    assert_eq!(texts(&cmd.output_rows), ["out"]);
}

#[test]
fn no_newline_shared_row_masked_in_snapshot() {
    // 命令输出无结尾换行 —— 那一行被命令块和活动区共用。命令块拿走前缀后,
    // snapshot 必须把前缀抹空,否则 Canvas 会和命令块重复画那段内容。
    let mut e = TerminalEngine::new(TerminalSize::new(10, 40));
    let stream = format!(
        "{}$ printf hi\r\n{}hi{}bash$ ",
        osc133("A"),
        osc133("C"),
        osc133("D;0"),
    );
    e.feed(stream.as_bytes());
    let cmd = drain_one(&mut e);
    assert_eq!(texts(&cmd.output_rows), ["hi"]);

    let snap = e.snapshot();
    let prompt_row = snap
        .rows
        .iter()
        .map(|r| r.cells.iter().map(|c| c.ch).collect::<String>())
        .find(|s| s.contains("bash$"))
        .expect("找到 prompt 行");
    assert!(
        prompt_row.starts_with("  bash$"),
        "命令块前缀应在 snapshot 里被抹空,实际 {prompt_row:?}",
    );
}

#[test]
fn marks_after_alt_screen_exit_in_same_chunk_are_kept() {
    // 一个 chunk 里「退出 alt-screen + 新 prompt 的 A/C/D」—— 不能因为
    // chunk 开头还在 alt-screen 就把后半段的真 mark 全丢了。
    let mut e = TerminalEngine::new(TerminalSize::new(10, 40));
    e.feed(b"\x1b[?1049h");
    let stream = format!(
        "\x1b[?1049l{}$ x\r\n{}out\r\n{}",
        osc133("A"),
        osc133("C"),
        osc133("D;0"),
    );
    e.feed(stream.as_bytes());
    let cmd = drain_one(&mut e);
    assert_eq!(texts(&cmd.output_rows), ["out"]);
}

#[test]
fn marks_inside_alt_screen_do_not_form_a_block() {
    // 一个 chunk 内进 alt-screen、完整跑一遍 A/C/D、再退出 —— alt-screen 里的
    // 133 没有命令块语义,不能混成一个块。
    let mut e = TerminalEngine::new(TerminalSize::new(10, 40));
    let stream = format!(
        "\x1b[?1049h{}$ junk\r\n{}junkout\r\n{}\x1b[?1049l",
        osc133("A"),
        osc133("C"),
        osc133("D;0"),
    );
    e.feed(stream.as_bytes());
    assert!(e.drain_marks().is_empty(), "alt-screen 里的命令不该成块");
}

#[test]
fn command_crossing_alt_screen_within_one_chunk_drops() {
    // A、C 之后,**同一 chunk 内**进 alt-screen、出 alt-screen、再 D ──
    // 中间没有 OSC mark。命令穿过了 alt-screen,不该假成块。
    let mut e = TerminalEngine::new(TerminalSize::new(10, 40));
    let stream = format!(
        "{}$ vimish\r\n{}\x1b[?1049hfullscreen\x1b[?1049l{}",
        osc133("A"),
        osc133("C"),
        osc133("D;0"),
    );
    e.feed(stream.as_bytes());
    assert!(e.drain_marks().is_empty(), "穿过 alt-screen 的命令不该成块");
}
