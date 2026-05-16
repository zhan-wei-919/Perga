//! 终端 cell 维度。
//!
//! 对外暴露 `TerminalSize { rows, cols }`,**不**暴露 pixel 维度 —— 第一刀
//! 不支持 sixel / iTerm image 这类需要像素信息的协议。
//!
//! 内部用一层 newtype `AlacrittyDims` 给 `alacritty_terminal::grid::Dimensions`
//! 实现 trait,避免把外部 trait impl 散到 public 数据类型上。

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalSize {
    pub rows: u16,
    pub cols: u16,
}

impl TerminalSize {
    pub const fn new(rows: u16, cols: u16) -> Self {
        Self { rows, cols }
    }
}

/// 给 alacritty 用的 `Dimensions` 桥接,只在 crate 内部使用。
pub(crate) struct AlacrittyDims {
    pub(crate) cols: usize,
    pub(crate) rows: usize,
}

impl AlacrittyDims {
    pub(crate) fn from(size: TerminalSize) -> Self {
        Self {
            cols: size.cols as usize,
            rows: size.rows as usize,
        }
    }
}

impl alacritty_terminal::grid::Dimensions for AlacrittyDims {
    fn columns(&self) -> usize {
        self.cols
    }

    fn screen_lines(&self) -> usize {
        self.rows
    }

    fn total_lines(&self) -> usize {
        // scrollback 由 alacritty Config::scrolling_history 控制,这里给 screen 大小
        // 即可;alacritty 的 grid 用 config 中的 history,total_lines 仅用于 resize 路径。
        self.rows
    }
}
