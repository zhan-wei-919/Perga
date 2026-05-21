//! Phase 3 协议事件测试:`CommandBlock` 形状 + `active_top` 字段。

use terminal_engine::{TerminalEngine, TerminalSize};
use terminal_protocol::{ProtocolEncoder, ProtocolEvent};

fn engine_with(text: &[u8], rows: u16, cols: u16) -> TerminalEngine {
    let mut e = TerminalEngine::new(TerminalSize::new(rows, cols));
    e.feed(text);
    e
}

#[test]
fn command_block_carries_command_and_output() {
    let engine = engine_with(b"$ echo hi\r\nhi", 6, 20);
    let snap = engine.snapshot();
    let mut encoder = ProtocolEncoder::new();
    let ev = encoder.encode_command_block(Some(0), &snap.rows[0..1], &snap.rows[1..2]);
    match ev {
        ProtocolEvent::CommandBlock {
            seq,
            exit,
            command,
            output,
        } => {
            assert_eq!(seq, 1);
            assert_eq!(exit, Some(0));
            assert_eq!(command.len(), 1);
            assert_eq!(output.len(), 1);
        }
        other => panic!("expected CommandBlock, got {other:?}"),
    }
}

#[test]
fn command_block_json_shape() {
    let engine = engine_with(b"$ x\r\nout", 6, 20);
    let snap = engine.snapshot();
    let mut encoder = ProtocolEncoder::new();
    let ev = encoder.encode_command_block(None, &snap.rows[0..1], &snap.rows[1..2]);
    let value = serde_json::to_value(&ev).expect("serialize");
    assert_eq!(value["type"], "command_block");
    assert!(value["command"].is_array());
    assert!(value["output"].is_array());
    // exit = None → JSON null(该字段无 skip_serializing_if)。
    assert!(value["exit"].is_null());
}

#[test]
fn command_block_empty_output_is_empty_array() {
    let engine = engine_with(b"$ true", 6, 20);
    let snap = engine.snapshot();
    let mut encoder = ProtocolEncoder::new();
    let ev = encoder.encode_command_block(Some(0), &snap.rows[0..1], &[]);
    match ev {
        ProtocolEvent::CommandBlock { output, .. } => assert!(output.is_empty()),
        other => panic!("expected CommandBlock, got {other:?}"),
    }
}

#[test]
fn active_top_present_in_init_and_patch() {
    let engine = engine_with(b"", 6, 20);
    let mut encoder = ProtocolEncoder::new();

    let init = encoder.encode_frame(engine.snapshot(), engine.modes(), None, 3);
    let init_json = serde_json::to_value(&init).expect("serialize");
    assert_eq!(init_json["type"], "init");
    assert_eq!(init_json["active_top"], 3);

    let patch = encoder.encode_frame(engine.snapshot(), engine.modes(), None, 7);
    let patch_json = serde_json::to_value(&patch).expect("serialize");
    assert_eq!(patch_json["type"], "patch");
    assert_eq!(patch_json["active_top"], 7);
}

#[test]
fn seq_shared_across_frames_and_blocks() {
    let engine = engine_with(b"$ a\r\nb", 6, 20);
    let snap = engine.snapshot();
    let mut encoder = ProtocolEncoder::new();
    let f1 = encoder.encode_frame(engine.snapshot(), engine.modes(), None, 0);
    let blk = encoder.encode_command_block(Some(0), &snap.rows[0..1], &snap.rows[1..2]);
    let f2 = encoder.encode_frame(engine.snapshot(), engine.modes(), None, 0);
    let seq_of = |ev: &ProtocolEvent| match ev {
        ProtocolEvent::Init { seq, .. }
        | ProtocolEvent::Patch { seq, .. }
        | ProtocolEvent::CommandBlock { seq, .. }
        | ProtocolEvent::Exited { seq, .. } => *seq,
    };
    assert_eq!([seq_of(&f1), seq_of(&blk), seq_of(&f2)], [1, 2, 3]);
}
