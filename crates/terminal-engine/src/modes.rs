//! 终端运行时 mode。
//!
//! 只暴露需要的 mode:alt screen / application cursor /
//! bracketed paste / mouse reporting。其他(kitty keyboard、focus reporting
//! 等)等真正接到前端再加。

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct TerminalModes {
    pub alt_screen: bool,
    pub app_cursor: bool,
    pub bracketed_paste: bool,
    pub mouse_reporting: MouseReporting,
    /// SGR mouse coordinate encoding (`CSI ?1006h`)。决定 Input Encoder 走
    /// `\x1b[<button;col;row;M/m` 还是 X10 字节形态。tmux / vim / htop 启动时
    /// 主动开。
    pub sgr_mouse: bool,
    /// Focus 上报开关(`CSI ?1004h`)。开启时窗口失 / 获焦点要发 `\x1b[O`/`I`,
    /// vim 用它做失焦自动保存,tmux 用它切 pane 高亮。
    pub focus_reporting: bool,
}

/// 鼠标报告 mode。语义对齐 xterm 的 `?1000` / `?1002` / `?1003`。
///
/// alacritty 没有显式的 X10 mode,因此我们也不暴露 —— 它通常被 `Normal` 覆盖。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "snake_case"))]
pub enum MouseReporting {
    /// 不上报。前端鼠标只用于自己的选择 / 滚动。
    Off,
    /// `CSI ?1000h`,只报点击和释放。
    Normal,
    /// `CSI ?1002h`,点击 + 拖拽。
    Button,
    /// `CSI ?1003h`,点击 + 拖拽 + 移动(任意 motion)。
    Any,
}

impl TerminalModes {
    pub(crate) fn from_term_mode(mode: alacritty_terminal::term::TermMode) -> Self {
        use alacritty_terminal::term::TermMode;
        let mouse = if mode.contains(TermMode::MOUSE_MOTION) {
            MouseReporting::Any
        } else if mode.contains(TermMode::MOUSE_DRAG) {
            MouseReporting::Button
        } else if mode.contains(TermMode::MOUSE_REPORT_CLICK) {
            MouseReporting::Normal
        } else {
            MouseReporting::Off
        };
        Self {
            alt_screen: mode.contains(TermMode::ALT_SCREEN),
            app_cursor: mode.contains(TermMode::APP_CURSOR),
            bracketed_paste: mode.contains(TermMode::BRACKETED_PASTE),
            mouse_reporting: mouse,
            sgr_mouse: mode.contains(TermMode::SGR_MOUSE),
            focus_reporting: mode.contains(TermMode::FOCUS_IN_OUT),
        }
    }
}
