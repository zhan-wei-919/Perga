//! Grid 快照及其元素类型。
//!
//! 都是值类型,与 `alacritty_terminal` 内部完全解耦。第一刀每次 `snapshot()`
//! 重新分配 `Vec<Row>` / `Vec<Cell>` —— 24×80 大约 ~2KB,优化等 Protocol
//! Encoder 真正需要 diff/damage 时再来。

use bitflags::bitflags;

use transport::TerminalSize;

/// 完整 grid 快照。
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct Snapshot {
    pub size: TerminalSize,
    pub cursor: Cursor,
    pub rows: Vec<Row>,
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct Row {
    pub cells: Vec<Cell>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct Cell {
    /// Cell 的主字符(extended grapheme cluster 的第一个 codepoint)。
    pub ch: char,
    /// 与 `ch` 组合成一个 grapheme cluster 的零宽 codepoint:combining
    /// marks(`e\u{301}` 里的 ◌́)、variation selectors、emoji ZWJ 序列等。
    /// 绝大多数 cell 这个 Vec 为空,empty `Vec::new()` 不做堆分配。
    pub combining: Vec<char>,
    pub width: CellWidth,
    pub fg: Color,
    pub bg: Color,
    pub attrs: CellAttrs,
}

impl Cell {
    /// 把 `ch` + `combining` 拼成完整的 extended grapheme cluster 字符串。
    /// 供 Protocol Encoder 等需要「这一格里完整人类可见字形」的场景使用。
    pub fn glyph(&self) -> String {
        let mut s = String::with_capacity(self.ch.len_utf8() + self.combining.len() * 2);
        s.push(self.ch);
        for c in &self.combining {
            s.push(*c);
        }
        s
    }

    /// 是不是「terminal 刚初始化时」的默认空白 cell。
    ///
    /// = ch=' ', combining 空, width=Single, fg=Foreground, bg=Background, attrs 空。
    /// Protocol Encoder 用这个判定做空白游程压缩。
    pub fn is_default_blank(&self) -> bool {
        self.ch == ' '
            && self.combining.is_empty()
            && self.width == CellWidth::Single
            && matches!(self.fg, Color::Named(NamedColor::Foreground))
            && matches!(self.bg, Color::Named(NamedColor::Background))
            && self.attrs.is_empty()
    }
}

/// 终端 cell 的宽度语义。
///
/// `Wide` 是 CJK 等双宽字符的主格;`WideSpacer` 是它右边那一格的占位符 ——
/// alacritty 用一个独立 cell 记 spacer,这样光标 / 选择 / hit-test 都和单宽
/// 字符走一样的坐标模型。前端如果合并绘制,**绝对不能**把 spacer 跨掉,
/// 否则会破坏 cell 语义(见架构文档「禁止把连续字符改写成语义组件」)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "snake_case"))]
pub enum CellWidth {
    Single,
    Wide,
    WideSpacer,
}

/// 终端颜色。三种形态都保留,Protocol Encoder 决定怎么编。
///
/// `Indexed(u8)` 是 256 调色板索引(0-15 同时也是 named ANSI);解析为
/// 具体 RGB 需要 terminal 颜色表,**不**在 Adapter 这一层做。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "snake_case"))]
pub enum Color {
    Named(NamedColor),
    Rgb { r: u8, g: u8, b: u8 },
    Indexed(u8),
}

/// 抽象的终端「named color」槽位。和 vte 的 `NamedColor` 一一对应。
///
/// `Foreground` / `Background` 是「使用当前默认前/背景色」语义,不是具体
/// 颜色值。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "snake_case"))]
pub enum NamedColor {
    Black,
    Red,
    Green,
    Yellow,
    Blue,
    Magenta,
    Cyan,
    White,
    BrightBlack,
    BrightRed,
    BrightGreen,
    BrightYellow,
    BrightBlue,
    BrightMagenta,
    BrightCyan,
    BrightWhite,
    Foreground,
    Background,
    Cursor,
    DimBlack,
    DimRed,
    DimGreen,
    DimYellow,
    DimBlue,
    DimMagenta,
    DimCyan,
    DimWhite,
    BrightForeground,
    DimForeground,
}

bitflags! {
    /// Cell 字符属性。
    ///
    /// 各种 underline 变体(double / curly / dotted / dashed)目前全部
    /// 合并成 `UNDERLINE`。等前端真要画 squiggle / dotted 时再细分。
    // 不在这里 derive Serialize ── bitflags 自带的 serde 会序列化成
    // "BOLD | ITALIC" 这种 human-readable 字符串,前端协议不够稳定。
    // 文件末尾有手写 Serialize impl,输出 snake_case 字符串数组。
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
    pub struct CellAttrs: u16 {
        const BOLD          = 1 << 0;
        const DIM           = 1 << 1;
        const ITALIC        = 1 << 2;
        const UNDERLINE     = 1 << 3;
        const REVERSE       = 1 << 4;
        const HIDDEN        = 1 << 5;
        const STRIKETHROUGH = 1 << 6;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct Cursor {
    pub row: u16,
    pub col: u16,
    pub visible: bool,
    pub style: CursorStyle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "snake_case"))]
pub enum CursorStyle {
    Block,
    Underline,
    Beam,
    Hidden,
}

/// `CellAttrs` 的 wire format:set 中的 flag 按 bit 顺序输出 snake_case 字符串
/// 数组。`CellAttrs::empty()` 序列化为 `[]`。前端不需要懂 bit 位,只按字段名读。
///
/// 同步注意:这里的字符串和 [`CellAttrs`] 的 `const NAME` 一一对应。新增 flag
/// **必须**在这里也加一行,否则会在 JSON 里被静默丢掉。
#[cfg(feature = "serde")]
impl serde::Serialize for CellAttrs {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeSeq;

        const FLAGS: &[(CellAttrs, &str)] = &[
            (CellAttrs::BOLD, "bold"),
            (CellAttrs::DIM, "dim"),
            (CellAttrs::ITALIC, "italic"),
            (CellAttrs::UNDERLINE, "underline"),
            (CellAttrs::REVERSE, "reverse"),
            (CellAttrs::HIDDEN, "hidden"),
            (CellAttrs::STRIKETHROUGH, "strikethrough"),
        ];

        let count = FLAGS.iter().filter(|(f, _)| self.contains(*f)).count();
        let mut seq = serializer.serialize_seq(Some(count))?;
        for (flag, name) in FLAGS {
            if self.contains(*flag) {
                seq.serialize_element(name)?;
            }
        }
        seq.end()
    }
}
