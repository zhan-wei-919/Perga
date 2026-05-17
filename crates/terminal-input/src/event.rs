//! 语义输入事件类型。
//!
//! 这些类型是 Input Encoder 的输入面 ── 前端从浏览器 DOM 事件归一化后送进来,
//! Encoder 根据当前 [`TerminalModes`](terminal_engine::TerminalModes) 翻成 PTY
//! 字节。归一化是前端的事(macOS Alt 合成的 .key 要回退到 .code、IME
//! compositionend 拿到合成结果、focus / blur 监听 ...),这一层只看语义。
//!
//! 边界验证集中在这里:[`FunctionKey`] 限定 1..=12,[`MouseEvent::col`]/`row`
//! 用 [`NonZeroU16`] 强制 1-indexed,Encoder 信任已经过验证的类型,不再补特殊
//! 分支。

use std::num::NonZeroU16;

/// 一次键盘事件。
///
/// `Char` 包括印刷字符和 IME 合成结果;其他 variant 是 xterm 协议里有专门
/// escape 序列的特殊键。
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Deserialize))]
pub struct KeyEvent {
    pub key: Key,
    #[cfg_attr(feature = "serde", serde(default))]
    pub mods: Modifiers,
}

/// 语义键。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(tag = "type", rename_all = "snake_case"))]
pub enum Key {
    /// 印刷字符 / IME 合成结果。Shift 已经反映在 `value` 上(`a` vs `A`)。
    Char {
        value: char,
    },
    Enter,
    Tab,
    Backspace,
    Escape,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    Insert,
    Delete,
    /// 功能键。`n` 类型保证范围 1..=12,见 [`FunctionKey`]。
    F {
        n: FunctionKey,
    },
}

/// 功能键编号:1..=12。
///
/// 这是输入面的边界类型 ── 构造时验证一次,Encoder 信任范围不再做兜底。
/// serde Deserialize 同样在边界拒绝非法值,前端送 `F13` / `F0` 会直接报错,
/// 不会变成静默空字节序列。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FunctionKey(u8);

impl FunctionKey {
    /// 构造功能键。`n` 必须在 1..=12,否则返回 `None`。
    pub fn new(n: u8) -> Option<Self> {
        if (1..=12).contains(&n) {
            Some(Self(n))
        } else {
            None
        }
    }

    /// 取回原始编号(1..=12)。
    pub fn get(self) -> u8 {
        self.0
    }
}

#[cfg(feature = "serde")]
impl<'de> serde::Deserialize<'de> for FunctionKey {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let n = u8::deserialize(deserializer)?;
        Self::new(n).ok_or_else(|| {
            serde::de::Error::custom(format!("function key must be in 1..=12, got {n}"))
        })
    }
}

/// 修饰符。**不**暴露 `meta` ── macOS Cmd / Win 键在 webview 多半被系统吞,
/// terminal 协议没有标准 meta 编码,加进来只会引入歧义。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
pub struct Modifiers {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
}

/// 鼠标事件。前端做 pixel → cell 转换(用最新一帧 size + DOM 容器位置),
/// 这一层只看 1-indexed 网格坐标。
///
/// `col` / `row` 用 [`NonZeroU16`] 强制 ≥ 1 ── 0 在 1-indexed 网格里没意义,
/// 让类型系统在边界挡住。serde Deserialize 自动拒绝 0。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Deserialize))]
pub struct MouseEvent {
    pub kind: MouseEventKind,
    pub col: NonZeroU16,
    pub row: NonZeroU16,
    #[cfg_attr(feature = "serde", serde(default))]
    pub mods: Modifiers,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(tag = "type", rename_all = "snake_case"))]
pub enum MouseEventKind {
    Press {
        button: MouseButton,
    },
    Release {
        button: MouseButton,
    },
    /// 拖拽 ── 按住按钮的 motion。只在 `Button` / `Any` 模式上报。
    Drag {
        button: MouseButton,
    },
    /// 任意 motion ── 只在 `Any` 模式上报,频率高。
    Motion,
    WheelUp,
    WheelDown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "snake_case"))]
pub enum MouseButton {
    Left,
    Middle,
    Right,
}
