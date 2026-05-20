//! WebSocket 入站消息(client → server)的 wire 类型。
//!
//! 协议形状(`tag = "type"`,snake_case):
//!
//! ```jsonc
//! { "type": "key",    "key": { "type": "char", "value": "a" }, "mods": {...} }
//! { "type": "paste",  "text": "..." }
//! { "type": "mouse",  "kind": { "type": "press", "button": "left" }, "col": 12, "row": 4, "mods": {...} }
//! { "type": "focus",  "gained": true }
//! { "type": "resize", "rows": 36, "cols": 120 }
//! ```
//!
//! Key / Mouse 复用 `terminal_input` 已经 derive 好的 `Deserialize` ── 那
//! 一层就是边界类型(`FunctionKey` 1..=12,`MouseEvent::col/row` `NonZeroU16`),
//! 非法值在反序列化阶段直接拒绝,server 内部不再补特殊分支。

use serde::Deserialize;
use terminal_engine::TerminalSize;
use terminal_input::{KeyEvent, MouseEvent};
use terminal_session::SessionInput;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    /// 键盘事件。`KeyEvent` 的 `key` / `mods` 字段在 envelope 平铺。
    Key(KeyEvent),
    /// 粘贴文本。后端按当前 bracketed paste 模式自行包裹。
    Paste { text: String },
    /// 鼠标事件。是否实际写入 PTY 取决于 mouse reporting 模式。
    Mouse(MouseEvent),
    /// 窗口聚焦变化。focus reporting 关闭时后端会丢弃。
    Focus { gained: bool },
    /// 终端尺寸变化。会同时驱动 engine.resize 和 PTY SIGWINCH。
    Resize { rows: u16, cols: u16 },
}

impl ClientMessage {
    /// 转成 `terminal-session` 那一层的输入命令。无副作用、不验证 ──
    /// 验证已经在 Deserialize 阶段完成(`FunctionKey::new` / `NonZeroU16`)。
    pub fn into_session_input(self) -> SessionInput {
        match self {
            Self::Key(k) => SessionInput::Key(k),
            Self::Paste { text } => SessionInput::Paste(text),
            Self::Mouse(m) => SessionInput::Mouse(m),
            Self::Focus { gained } => SessionInput::Focus(gained),
            Self::Resize { rows, cols } => SessionInput::Resize(TerminalSize::new(rows, cols)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_char_key() {
        let raw = r#"{"type":"key","key":{"type":"char","value":"a"},"mods":{"ctrl":true}}"#;
        let msg: ClientMessage = serde_json::from_str(raw).expect("parse");
        match msg.into_session_input() {
            SessionInput::Key(k) => {
                assert!(k.mods.ctrl);
                assert!(!k.mods.shift);
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn parses_resize() {
        let raw = r#"{"type":"resize","rows":40,"cols":120}"#;
        let msg: ClientMessage = serde_json::from_str(raw).expect("parse");
        match msg.into_session_input() {
            SessionInput::Resize(s) => assert_eq!((s.rows, s.cols), (40, 120)),
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn parses_paste() {
        let raw = r#"{"type":"paste","text":"hello"}"#;
        let msg: ClientMessage = serde_json::from_str(raw).expect("parse");
        match msg.into_session_input() {
            SessionInput::Paste(s) => assert_eq!(s, "hello"),
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn parses_focus() {
        let raw = r#"{"type":"focus","gained":false}"#;
        let msg: ClientMessage = serde_json::from_str(raw).expect("parse");
        match msg.into_session_input() {
            SessionInput::Focus(g) => assert!(!g),
            other => panic!("wrong variant: {other:?}"),
        }
    }

    /// FunctionKey 边界拒绝:F13 在 terminal-input 那一层被拦,这里不再重复。
    /// 仅断言 server wire 不会把它解出来。
    #[test]
    fn rejects_invalid_function_key() {
        let raw = r#"{"type":"key","key":{"type":"f","n":13}}"#;
        let err = serde_json::from_str::<ClientMessage>(raw).expect_err("expected reject");
        assert!(
            err.to_string().contains("function key"),
            "expected function-key error, got: {err}"
        );
    }
}
