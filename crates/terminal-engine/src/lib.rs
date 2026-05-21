//! 终端引擎适配层。
//!
//! 把 PTY 字节喂给 `alacritty_terminal::Term` 维护的状态机,对外只暴露
//! 我们自己定义的快照 / mode 类型,**不**外泄 alacritty 内部类型。
//! 本层是 **PTY Manager → Protocol Encoder** 之间的桥梁:把字节翻成
//! 「规范化的终端语义」,Protocol Encoder 再把它编码成 snapshot/diff
//! 事件给前端。

mod engine;
mod listener;
mod modes;
mod shell_integration;
mod size;
mod snapshot;

pub use engine::{ResolvedCommand, TerminalEngine};
pub use modes::{MouseReporting, TerminalModes};
pub use size::TerminalSize;
pub use snapshot::{
    Cell, CellAttrs, CellWidth, Color, Cursor, CursorStyle, NamedColor, Row, Snapshot,
};
