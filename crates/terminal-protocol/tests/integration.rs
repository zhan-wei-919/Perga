//! `terminal-protocol` 集成测试。
//!
//! 每个测试独立 `ProtocolEncoder::new()` + `TerminalEngine::new(...)`,只用
//! 两层公开 API 构造输入。**不**碰 alacritty 内部状态,断言全打在协议形状上。

use terminal_engine::{CellWidth, TerminalEngine, TerminalSize};
use terminal_protocol::{
    DirtyRow, ExitStatus, ProtocolEncoder, ProtocolEvent, RowEntry, TitleChange,
};

fn setup() -> (TerminalEngine, ProtocolEncoder) {
    (
        TerminalEngine::new(TerminalSize::new(24, 80)),
        ProtocolEncoder::new(),
    )
}

fn encode_current(engine: &TerminalEngine, encoder: &mut ProtocolEncoder) -> ProtocolEvent {
    encoder.encode_frame(engine.snapshot(), engine.modes(), engine.title())
}

fn init_rows(event: &ProtocolEvent) -> &Vec<Vec<RowEntry>> {
    match event {
        ProtocolEvent::Init { rows, .. } => rows,
        other => panic!("expected Init, got {other:?}"),
    }
}

fn patch_dirty(event: &ProtocolEvent) -> &Vec<DirtyRow> {
    match event {
        ProtocolEvent::Patch { dirty_rows, .. } => dirty_rows,
        other => panic!("expected Patch, got {other:?}"),
    }
}

// ────────────────────── 基础事件流 ──────────────────────

#[test]
fn first_encode_emits_init() {
    let (engine, mut encoder) = setup();
    let event = encode_current(&engine, &mut encoder);
    match event {
        ProtocolEvent::Init {
            seq,
            size,
            ref rows,
            ref title,
            ..
        } => {
            assert_eq!(seq, 1);
            assert_eq!(size, TerminalSize::new(24, 80));
            assert_eq!(rows.len(), 24);
            assert!(title.is_none());
        }
        other => panic!("expected Init, got {other:?}"),
    }
}

#[test]
fn second_encode_no_change_emits_patch_with_empty_dirty() {
    let (engine, mut encoder) = setup();
    let _ = encode_current(&engine, &mut encoder); // Init
    let event = encode_current(&engine, &mut encoder);
    match event {
        ProtocolEvent::Patch {
            seq,
            dirty_rows,
            modes,
            title,
            ..
        } => {
            assert_eq!(seq, 2);
            assert!(dirty_rows.is_empty(), "no input, no dirty rows");
            assert!(modes.is_none(), "modes unchanged");
            assert!(title.is_none(), "title unchanged");
        }
        other => panic!("expected Patch, got {other:?}"),
    }
}

#[test]
fn resize_emits_init() {
    let (mut engine, mut encoder) = setup();
    let _ = encode_current(&engine, &mut encoder); // Init seq=1
    engine.resize(TerminalSize::new(40, 120));
    let event = encode_current(&engine, &mut encoder);
    match event {
        ProtocolEvent::Init {
            seq, size, rows, ..
        } => {
            assert_eq!(seq, 2);
            assert_eq!(size, TerminalSize::new(40, 120));
            assert_eq!(rows.len(), 40);
        }
        other => panic!("expected Init after resize, got {other:?}"),
    }
}

#[test]
fn exited_event_has_status() {
    let (engine, mut encoder) = setup();
    let _ = encode_current(&engine, &mut encoder); // Init seq=1
    let event = encoder.encode_exited(ExitStatus {
        code: Some(0),
        signal: None,
    });
    match event {
        ProtocolEvent::Exited { seq, status } => {
            assert_eq!(seq, 2);
            assert_eq!(status.code, Some(0));
            assert_eq!(status.signal, None);
        }
        other => panic!("expected Exited, got {other:?}"),
    }
}

#[test]
fn seq_monotonic() {
    let (engine, mut encoder) = setup();
    let mut seqs = Vec::new();
    for _ in 0..5 {
        let ev = encode_current(&engine, &mut encoder);
        match ev {
            ProtocolEvent::Init { seq, .. } | ProtocolEvent::Patch { seq, .. } => seqs.push(seq),
            other => panic!("unexpected: {other:?}"),
        }
    }
    assert_eq!(seqs, vec![1, 2, 3, 4, 5]);
}

// ────────────────────── RLE 形态:Blank / Text / Cells ──────────────────────

#[test]
fn empty_grid_init_uses_blank_runs() {
    let (engine, mut encoder) = setup();
    let event = encode_current(&engine, &mut encoder);
    let rows = init_rows(&event);
    assert_eq!(rows.len(), 24);
    for (i, row) in rows.iter().enumerate() {
        assert_eq!(row.len(), 1, "row {i} should have a single Blank entry");
        match &row[0] {
            RowEntry::Blank { count } => assert_eq!(*count, 80, "row {i} blank count"),
            other => panic!("row {i} expected Blank, got {other:?}"),
        }
    }
}

/// 锁住空 24×80 grid 一帧 Init 的 JSON 字节数。改坏 RLE 时会立刻打到。
#[test]
fn empty_grid_init_byte_budget() {
    let (engine, mut encoder) = setup();
    let event = encode_current(&engine, &mut encoder);
    let json = serde_json::to_string(&event).expect("init should serialize");
    assert!(
        json.len() < 2048,
        "empty 24×80 Init should fit in 2KB, got {} bytes: {}",
        json.len(),
        json
    );
}

#[test]
fn text_run_aggregates_same_attrs() {
    let (mut engine, mut encoder) = setup();
    let _ = encode_current(&engine, &mut encoder); // Init
    engine.feed(b"Hello");
    let event = encode_current(&engine, &mut encoder);
    let dirty = patch_dirty(&event);
    assert_eq!(dirty.len(), 1, "only row 0 should be dirty");
    assert_eq!(dirty[0].index, 0);
    // 期望:Text("Hello") + Blank(75)。
    assert_eq!(dirty[0].entries.len(), 2);
    match &dirty[0].entries[0] {
        RowEntry::Text { s, .. } => assert_eq!(s, "Hello"),
        other => panic!("expected Text, got {other:?}"),
    }
    match &dirty[0].entries[1] {
        RowEntry::Blank { count } => assert_eq!(*count, 75),
        other => panic!("expected Blank, got {other:?}"),
    }
}

#[test]
fn text_run_breaks_on_color_change() {
    let (mut engine, mut encoder) = setup();
    // 初始 Init,然后 feed 红 ABC + 蓝 DEF + reset。
    let _ = encode_current(&engine, &mut encoder);
    engine.feed(b"\x1b[31mABC\x1b[34mDEF\x1b[0m");
    let event = encode_current(&engine, &mut encoder);
    let dirty = patch_dirty(&event);
    assert_eq!(dirty.len(), 1);
    let entries = &dirty[0].entries;
    // 前两个 entry 必须都是 Text,s 分别 "ABC" / "DEF",fg 不同。
    let (s0, fg0) = match &entries[0] {
        RowEntry::Text { s, fg, .. } => (s.clone(), *fg),
        other => panic!("entries[0] expected Text, got {other:?}"),
    };
    let (s1, fg1) = match &entries[1] {
        RowEntry::Text { s, fg, .. } => (s.clone(), *fg),
        other => panic!("entries[1] expected Text, got {other:?}"),
    };
    assert_eq!(s0, "ABC");
    assert_eq!(s1, "DEF");
    assert_ne!(fg0, fg1, "color change must split text runs");
}

#[test]
fn wide_char_goes_to_cells() {
    let (mut engine, mut encoder) = setup();
    let _ = encode_current(&engine, &mut encoder); // Init
    engine.feed("你".as_bytes());
    let event = encode_current(&engine, &mut encoder);
    let dirty = patch_dirty(&event);
    assert_eq!(dirty.len(), 1);
    let entries = &dirty[0].entries;
    // 第一个 entry 必须是 Cells,内含 Wide + WideSpacer。
    match &entries[0] {
        RowEntry::Cells { cells } => {
            assert_eq!(cells.len(), 2, "wide char pair must have 2 cells");
            assert_eq!(cells[0].ch, '你');
            assert_eq!(cells[0].width, CellWidth::Wide);
            assert_eq!(cells[1].width, CellWidth::WideSpacer);
        }
        other => panic!("entries[0] expected Cells, got {other:?}"),
    }
    // 剩下 78 列应该是 Blank。
    match entries.last().expect("entries non-empty") {
        RowEntry::Blank { count } => assert_eq!(*count, 78),
        other => panic!("last entry expected Blank, got {other:?}"),
    }
}

#[test]
fn combining_mark_goes_to_cells() {
    let (mut engine, mut encoder) = setup();
    let _ = encode_current(&engine, &mut encoder); // Init
    engine.feed("e\u{301}".as_bytes());
    let event = encode_current(&engine, &mut encoder);
    let dirty = patch_dirty(&event);
    assert_eq!(dirty.len(), 1);
    let entries = &dirty[0].entries;
    match &entries[0] {
        RowEntry::Cells { cells } => {
            assert_eq!(cells.len(), 1);
            assert_eq!(cells[0].ch, 'e');
            assert_eq!(cells[0].combining, vec!['\u{301}']);
        }
        other => panic!("entries[0] expected Cells, got {other:?}"),
    }
}

// ────────────────────── Patch / 状态变化 ──────────────────────

#[test]
fn typing_creates_dirty_row_only() {
    let (mut engine, mut encoder) = setup();
    let _ = encode_current(&engine, &mut encoder); // Init
    engine.feed(b"hello");
    let event = encode_current(&engine, &mut encoder);
    let dirty = patch_dirty(&event);
    assert_eq!(dirty.len(), 1, "only row 0 should be dirty");
    assert_eq!(dirty[0].index, 0);
}

#[test]
fn title_change_emits_patch_with_title() {
    let (mut engine, mut encoder) = setup();
    let _ = encode_current(&engine, &mut encoder); // Init
    engine.feed(b"\x1b]2;hello\x07");
    let event = encode_current(&engine, &mut encoder);
    match event {
        ProtocolEvent::Patch { title, .. } => {
            assert_eq!(
                title,
                Some(TitleChange::Set {
                    value: "hello".into()
                })
            );
        }
        other => panic!("expected Patch with title, got {other:?}"),
    }
}

/// title 由 `Some` → `None` 产生 `Reset`。直接走 Encoder API 验证,避免依赖
/// alacritty 对「OSC 0/2 空字串」的具体处理路径(是 Title("") 还是
/// ResetTitle 取决于 vte 版本)。
#[test]
fn title_clear_to_none_emits_reset() {
    let (engine, mut encoder) = setup();
    let _ = encoder.encode_frame(engine.snapshot(), engine.modes(), Some("x".into())); // Init
    let event = encoder.encode_frame(engine.snapshot(), engine.modes(), None);
    match event {
        ProtocolEvent::Patch { title, .. } => {
            assert_eq!(title, Some(TitleChange::Reset));
        }
        other => panic!("expected Patch with Reset, got {other:?}"),
    }
}

#[test]
fn alt_screen_toggle_emits_modes_change() {
    let (mut engine, mut encoder) = setup();
    let _ = encode_current(&engine, &mut encoder); // Init
    engine.feed(b"\x1b[?1049h");
    let event = encode_current(&engine, &mut encoder);
    match event {
        ProtocolEvent::Patch { modes, .. } => {
            let modes = modes.expect("alt_screen toggle should report modes change");
            assert!(modes.alt_screen);
        }
        other => panic!("expected Patch with modes change, got {other:?}"),
    }
}

// ────────────────────── JSON 形状 / wire format 回归 ──────────────────────

#[test]
fn json_shape_init_envelope() {
    let (engine, mut encoder) = setup();
    let event = encode_current(&engine, &mut encoder);
    let value = serde_json::to_value(&event).expect("init should serialize");
    assert_eq!(value["type"], "init");
    assert_eq!(value["seq"], 1);
    assert!(value["rows"].is_array());
    // rows[0] 是 entry 数组,不是包了一层的 object。
    assert!(value["rows"][0].is_array());
    // 每行第一个 entry 是 Blank。
    assert_eq!(value["rows"][0][0]["type"], "blank");
    assert_eq!(value["rows"][0][0]["count"], 80);
}

#[test]
fn json_shape_nested_enums_snake_case() {
    let (engine, mut encoder) = setup();
    let event = encode_current(&engine, &mut encoder);
    let value = serde_json::to_value(&event).expect("init should serialize");

    // cursor.style:CursorStyle::Block → snake_case "block"。
    assert_eq!(value["cursor"]["style"], "block");
    // modes.mouse_reporting:MouseReporting::Off。
    assert_eq!(value["modes"]["mouse_reporting"], "off");
}

#[test]
fn default_text_omits_fg_bg_attrs() {
    let (mut engine, mut encoder) = setup();
    let _ = encode_current(&engine, &mut encoder); // Init
    engine.feed(b"X");
    let event = encode_current(&engine, &mut encoder);
    let value = serde_json::to_value(&event).expect("patch should serialize");
    let entry = &value["dirty_rows"][0]["entries"][0];
    assert_eq!(entry["type"], "text");
    assert_eq!(entry["s"], "X");
    let obj = entry.as_object().expect("entry should be object");
    assert!(!obj.contains_key("fg"), "fg should be omitted (default)");
    assert!(!obj.contains_key("bg"), "bg should be omitted (default)");
    assert!(
        !obj.contains_key("attrs"),
        "attrs should be omitted (empty)"
    );
}

#[test]
fn colored_text_includes_fg_but_not_bg_attrs() {
    let (mut engine, mut encoder) = setup();
    let _ = encode_current(&engine, &mut encoder); // Init
    engine.feed(b"\x1b[31mX");
    let event = encode_current(&engine, &mut encoder);
    let value = serde_json::to_value(&event).expect("patch should serialize");
    let entry = &value["dirty_rows"][0]["entries"][0];
    let obj = entry.as_object().expect("entry should be object");
    assert!(
        obj.contains_key("fg"),
        "fg should be present when not default"
    );
    assert!(!obj.contains_key("bg"), "bg should be omitted when default");
    assert!(
        !obj.contains_key("attrs"),
        "attrs should be omitted when empty"
    );
}

#[test]
fn json_shape_cell_attrs_and_rgb_color_via_text() {
    let (mut engine, mut encoder) = setup();
    // 初始 Init,然后 feed bold + RGB red "X" ── 单宽 + 无 combining,走 Text run。
    let _ = encode_current(&engine, &mut encoder);
    engine.feed(b"\x1b[1;38;2;255;0;0mX\x1b[0m");
    let event = encode_current(&engine, &mut encoder);
    let value = serde_json::to_value(&event).expect("patch should serialize");
    let entry = &value["dirty_rows"][0]["entries"][0];
    assert_eq!(entry["type"], "text");
    assert_eq!(entry["s"], "X");
    // attrs 字符串数组形态,含 "bold"。
    let attrs = entry["attrs"].as_array().expect("attrs should be array");
    assert!(
        attrs.iter().any(|v| v == "bold"),
        "expected attrs to contain \"bold\", got {attrs:?}"
    );
    // fg = RGB:{ rgb: { r, g, b } }。
    assert_eq!(
        entry["fg"],
        serde_json::json!({ "rgb": { "r": 255, "g": 0, "b": 0 } })
    );
}

#[test]
fn json_shape_patch_omits_unset_modes_title() {
    let (engine, mut encoder) = setup();
    let _ = encode_current(&engine, &mut encoder); // Init
    let patch_event = encode_current(&engine, &mut encoder);
    let value = serde_json::to_value(&patch_event).expect("patch should serialize");
    assert_eq!(value["type"], "patch");
    let obj = value.as_object().expect("patch should be object");
    assert!(!obj.contains_key("modes"), "modes key should be omitted");
    assert!(!obj.contains_key("title"), "title key should be omitted");
    assert!(obj.contains_key("dirty_rows"));
    assert_eq!(value["dirty_rows"].as_array().map(Vec::len), Some(0));
}
