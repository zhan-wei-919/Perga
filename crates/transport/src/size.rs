//! 终端 cell 维度。
//!
//! 对外只暴露 `TerminalSize { rows, cols }`,**不**暴露 pixel 维度 —— 第一刀
//! 不支持 sixel / iTerm image 这类需要像素信息的协议。各 backend 内部把这个
//! 类型转成自己需要的形态(`portable_pty::PtySize`、SSH `window_change` 参数)。

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct TerminalSize {
    pub rows: u16,
    pub cols: u16,
}

impl TerminalSize {
    pub const fn new(rows: u16, cols: u16) -> Self {
        Self { rows, cols }
    }
}
