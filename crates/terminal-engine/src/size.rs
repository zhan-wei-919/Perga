//! 给 alacritty 用的 `Dimensions` 桥接。
//!
//! 对外的 `TerminalSize { rows, cols }` 已经统一到 [`transport::TerminalSize`],
//! 在 [`crate::lib`] 里 re-export。本模块只剩 `AlacrittyDims` —— alacritty
//! 内部 trait 的 newtype impl,避免把外部 trait impl 散到 public 类型上。

use transport::TerminalSize;

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
