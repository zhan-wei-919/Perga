//! `terminal-protocol` 集成测试。
//!
//! 每个测试独立 `ProtocolEncoder::new()` + `TerminalEngine::new(...)`,只用
//! 两层公开 API 构造输入。**不**碰 alacritty 内部状态,断言全打在协议形状上。

use terminal_engine::{TerminalEngine, TerminalSize};
use terminal_protocol::{ExitStatus, ProtocolEncoder, ProtocolEvent, TitleChange};

fn setup() -> (TerminalEngine, ProtocolEncoder) {
    (
        TerminalEngine::new(TerminalSize::new(24, 80)),
        ProtocolEncoder::new(),
    )
}

fn encode_current(engine: &TerminalEngine, encoder: &mut ProtocolEncoder) -> ProtocolEvent {
    encoder.encode_frame(engine.snapshot(), engine.modes(), engine.title())
}

#[test]
fn first_encode_emits_init() {
    let (engine, mut encoder) = setup();
    let event = encode_current(&engine, &mut encoder);
    match event {
        ProtocolEvent::Init {
            seq,
            size,
            rows,
            title,
            ..
        } => {
            assert_eq!(seq, 1);
            assert_eq!(size, TerminalSize::new(24, 80));
            assert_eq!(rows.len(), 24);
            assert_eq!(rows[0].cells.len(), 80);
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
fn typing_creates_dirty_row() {
    let (mut engine, mut encoder) = setup();
    let _ = encode_current(&engine, &mut encoder); // Init
    engine.feed(b"hello");
    let event = encode_current(&engine, &mut encoder);
    match event {
        ProtocolEvent::Patch { dirty_rows, .. } => {
            assert_eq!(dirty_rows.len(), 1, "only row 0 should be dirty");
            assert_eq!(dirty_rows[0].index, 0);
            let chars: Vec<char> = dirty_rows[0].cells.iter().map(|c| c.ch).collect();
            assert_eq!(&chars[..5], &['h', 'e', 'l', 'l', 'o']);
        }
        other => panic!("expected Patch, got {other:?}"),
    }
}

#[test]
fn only_other_rows_clean() {
    let (mut engine, mut encoder) = setup();
    let _ = encode_current(&engine, &mut encoder); // Init
    engine.feed(b"hello");
    let event = encode_current(&engine, &mut encoder);
    if let ProtocolEvent::Patch { dirty_rows, .. } = event {
        // dirty_rows 只该带一条 index = 0;其他 23 行都没变,不应出现在 patch。
        for row in &dirty_rows {
            assert_eq!(row.index, 0, "unexpected dirty row {}", row.index);
        }
    } else {
        panic!("expected Patch");
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
            assert_eq!(rows[0].cells.len(), 120);
        }
        other => panic!("expected Init after resize, got {other:?}"),
    }
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

#[test]
fn json_shape_init() {
    let (engine, mut encoder) = setup();
    let event = encode_current(&engine, &mut encoder);
    let value = serde_json::to_value(&event).expect("init should serialize");
    assert_eq!(value["type"], "init");
    assert_eq!(value["seq"], 1);
    assert!(value["rows"].is_array(), "rows should be array");
    assert!(value["size"].is_object());
    assert!(value["cursor"].is_object());
    assert!(value["modes"].is_object());
}

/// 断 Init 帧里的嵌套 enum / bitflags wire 形状。
///
/// 这一组主要是回归 guard:engine 类型的 serde 默认形状(`"Single"` /
/// `"BOLD | ITALIC"` 这类 Rust-内部表示)曾被 review 指为「前端协议不够显式
/// 稳定」。锁住 snake_case + CellAttrs 字符串数组形态,以后改了能被打到。
#[test]
fn json_shape_nested_enums_snake_case() {
    let (engine, mut encoder) = setup();
    let event = encode_current(&engine, &mut encoder);
    let value = serde_json::to_value(&event).expect("init should serialize");

    // cursor.style:CursorStyle 默认 Block → 小写 snake_case。
    assert_eq!(value["cursor"]["style"], "block");

    // modes.mouse_reporting:MouseReporting::Off。
    assert_eq!(value["modes"]["mouse_reporting"], "off");

    // rows[0].cells[0].width:空白 cell 是 Single → "single"。
    assert_eq!(value["rows"][0]["cells"][0]["width"], "single");

    // rows[0].cells[0].attrs:CellAttrs::empty() → []。
    assert_eq!(value["rows"][0]["cells"][0]["attrs"], serde_json::json!([]));

    // rows[0].cells[0].fg:Color::Named(Foreground) → 外部 tag snake_case,
    // 内部 NamedColor 也 snake_case。
    assert_eq!(
        value["rows"][0]["cells"][0]["fg"],
        serde_json::json!({ "named": "foreground" })
    );
}

/// 给 grid 中放一格带属性 + RGB 色的 cell,断 wire 形状。
#[test]
fn json_shape_cell_attrs_and_rgb_color() {
    let (mut engine, mut encoder) = setup();
    // 粗体 + 红色前景 + "X"。
    engine.feed(b"\x1b[1;38;2;255;0;0mX\x1b[0m");
    let event = encode_current(&engine, &mut encoder);
    let value = serde_json::to_value(&event).expect("init should serialize");

    let cell = &value["rows"][0]["cells"][0];
    assert_eq!(cell["ch"], "X");
    // attrs 是字符串数组,且包含 "bold"。
    let attrs = cell["attrs"].as_array().expect("attrs should be array");
    assert!(
        attrs.iter().any(|v| v == "bold"),
        "expected attrs to contain \"bold\", got {attrs:?}"
    );
    // fg 是 RGB:{ rgb: { r, g, b } }。
    assert_eq!(
        cell["fg"],
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
    // skip_serializing_if 生效:空 patch 不应出现 modes / title key。
    assert!(!obj.contains_key("modes"), "modes key should be omitted");
    assert!(!obj.contains_key("title"), "title key should be omitted");
    // dirty_rows 总是出现(空数组也写),前端可以 `for-of` 直接迭代。
    assert!(obj.contains_key("dirty_rows"));
    assert_eq!(value["dirty_rows"].as_array().map(Vec::len), Some(0));
}
