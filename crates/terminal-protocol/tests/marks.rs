//! 协议事件测试:`CommandEnd` 形状 + `Patch` 的 scrolled_rows / cleared 字段。

use terminal_engine::{TerminalEngine, TerminalSize};
use terminal_protocol::{ProtocolEncoder, ProtocolEvent};

fn engine_with(text: &[u8], rows: u16, cols: u16) -> TerminalEngine {
    let mut e = TerminalEngine::new(TerminalSize::new(rows, cols));
    e.feed(text);
    e
}

#[test]
fn command_end_shape() {
    let mut encoder = ProtocolEncoder::new();
    let ev = encoder.encode_command_end(7, Some(1));
    match ev {
        ProtocolEvent::CommandEnd { seq, exit, line } => {
            assert_eq!(seq, 1);
            assert_eq!(exit, Some(1));
            assert_eq!(line, 7);
        }
        other => panic!("expected CommandEnd, got {other:?}"),
    }
}

#[test]
fn command_end_json_shape() {
    let mut encoder = ProtocolEncoder::new();
    let ev = encoder.encode_command_end(3, None);
    let value = serde_json::to_value(&ev).expect("serialize");
    assert_eq!(value["type"], "command_end");
    assert_eq!(value["line"], 3);
    // exit = None → JSON null(无 skip_serializing_if)。
    assert!(value["exit"].is_null());
}

#[test]
fn init_omits_scroll_fields() {
    let engine = engine_with(b"", 6, 20);
    let mut encoder = ProtocolEncoder::new();
    let init = encoder.encode_frame(engine.snapshot(), engine.modes(), None, &[], false);
    let json = serde_json::to_value(&init).expect("serialize");
    assert_eq!(json["type"], "init");
    assert!(json.get("active_top").is_none(), "active_top 已移除");
    assert!(
        json.get("scrolled_rows").is_none(),
        "Init 不带 scrolled_rows"
    );
    assert!(json.get("cleared").is_none());
}

#[test]
fn patch_carries_scrolled_rows() {
    let engine = engine_with(b"hello", 6, 20);
    let snap = engine.snapshot();
    let mut encoder = ProtocolEncoder::new();
    // 首帧 Init 建立缓存。
    let _ = encoder.encode_frame(engine.snapshot(), engine.modes(), None, &[], false);
    // 第二帧 Patch,带一行 scrolled。
    let patch = encoder.encode_frame(
        engine.snapshot(),
        engine.modes(),
        None,
        &snap.rows[0..1],
        false,
    );
    match patch {
        ProtocolEvent::Patch {
            scrolled_rows,
            cleared,
            ..
        } => {
            assert_eq!(scrolled_rows.len(), 1);
            assert!(!cleared);
        }
        other => panic!("expected Patch, got {other:?}"),
    }
}

#[test]
fn patch_empty_scroll_fields_skipped_in_json() {
    let engine = engine_with(b"", 6, 20);
    let mut encoder = ProtocolEncoder::new();
    let _ = encoder.encode_frame(engine.snapshot(), engine.modes(), None, &[], false);
    let patch = encoder.encode_frame(engine.snapshot(), engine.modes(), None, &[], false);
    let json = serde_json::to_value(&patch).expect("serialize");
    assert_eq!(json["type"], "patch");
    // 空 scrolled_rows / false cleared → wire 上不出现这两个 key。
    assert!(json.get("scrolled_rows").is_none());
    assert!(json.get("cleared").is_none());
}

#[test]
fn patch_cleared_flag_serialized() {
    let engine = engine_with(b"", 6, 20);
    let mut encoder = ProtocolEncoder::new();
    let _ = encoder.encode_frame(engine.snapshot(), engine.modes(), None, &[], false);
    let patch = encoder.encode_frame(engine.snapshot(), engine.modes(), None, &[], true);
    let json = serde_json::to_value(&patch).expect("serialize");
    assert_eq!(json["cleared"], true);
}

#[test]
fn seq_shared_across_frames_and_command_ends() {
    let engine = engine_with(b"hi", 6, 20);
    let mut encoder = ProtocolEncoder::new();
    let f1 = encoder.encode_frame(engine.snapshot(), engine.modes(), None, &[], false);
    let ce = encoder.encode_command_end(0, Some(0));
    let f2 = encoder.encode_frame(engine.snapshot(), engine.modes(), None, &[], false);
    let seq_of = |ev: &ProtocolEvent| match ev {
        ProtocolEvent::Init { seq, .. }
        | ProtocolEvent::Patch { seq, .. }
        | ProtocolEvent::CommandEnd { seq, .. }
        | ProtocolEvent::Exited { seq, .. } => *seq,
    };
    assert_eq!([seq_of(&f1), seq_of(&ce), seq_of(&f2)], [1, 2, 3]);
}
