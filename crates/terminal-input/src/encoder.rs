//! 四个 encode 函数:键盘 / 粘贴 / 鼠标 / 焦点 → PTY 字节。
//!
//! 所有函数都是纯函数,无状态,只依赖入参和 `&TerminalModes`。
//!
//! xterm baseline 协议:箭头 / Home / End mode-aware(SS3 vs CSI),特殊键带
//! 修饰符走 DEC param 参数化(`\x1b[1;<P>X` 形态),粘贴包裹 + 防 injection,
//! 鼠标按 mode 过滤 + SGR/X10 二选一,焦点 `\x1b[I`/`\x1b[O`。

use terminal_engine::{MouseReporting, TerminalModes};

use crate::event::{Key, KeyEvent, Modifiers, MouseButton, MouseEvent, MouseEventKind};

// ───────────────────────── 键盘 ─────────────────────────

/// 把语义键盘事件编码成 PTY 字节。
pub fn encode_key(event: &KeyEvent, modes: &TerminalModes) -> Vec<u8> {
    let mods = event.mods;
    match event.key {
        Key::Char { value } => encode_char(value, &mods),
        Key::Enter => vec![b'\r'],
        Key::Tab => {
            if mods.shift && !mods.ctrl && !mods.alt {
                b"\x1b[Z".to_vec()
            } else {
                vec![b'\t']
            }
        }
        Key::Backspace => vec![0x7f],
        Key::Escape => vec![0x1b],
        Key::Up => arrow_or_pos("A", &mods, modes),
        Key::Down => arrow_or_pos("B", &mods, modes),
        Key::Right => arrow_or_pos("C", &mods, modes),
        Key::Left => arrow_or_pos("D", &mods, modes),
        Key::Home => arrow_or_pos("H", &mods, modes),
        Key::End => arrow_or_pos("F", &mods, modes),
        Key::Insert => tilde_key(2, &mods),
        Key::Delete => tilde_key(3, &mods),
        Key::PageUp => tilde_key(5, &mods),
        Key::PageDown => tilde_key(6, &mods),
        Key::F { n } => encode_function_key(n.get(), &mods),
    }
}

fn encode_char(c: char, mods: &Modifiers) -> Vec<u8> {
    // Alt:递归无 Alt 形态,前面拼 ESC。
    if mods.alt {
        let inner_mods = Modifiers {
            alt: false,
            ..*mods
        };
        let mut out = vec![0x1b];
        out.extend(encode_char(c, &inner_mods));
        return out;
    }

    if mods.ctrl {
        // Ctrl 映射表。
        let ctrl_byte: Option<u8> = match c {
            'a'..='z' => Some(c as u8 - b'a' + 1),
            'A'..='Z' => Some(c as u8 - b'A' + 1),
            '@' | ' ' => Some(0x00),
            '[' => Some(0x1b),
            '\\' => Some(0x1c),
            ']' => Some(0x1d),
            '^' => Some(0x1e),
            '_' => Some(0x1f),
            _ => None,
        };
        if let Some(b) = ctrl_byte {
            return vec![b];
        }
        // 无 Ctrl 映射:UTF-8 直送,不丢用户输入。
    }

    // 默认 / Shift / 未映射 Ctrl:UTF-8 编 c。
    let mut buf = [0u8; 4];
    c.encode_utf8(&mut buf).as_bytes().to_vec()
}

/// 箭头 / Home / End 共享的编码逻辑。`letter` 是终结字符 A/B/C/D/H/F。
fn arrow_or_pos(letter: &str, mods: &Modifiers, modes: &TerminalModes) -> Vec<u8> {
    if has_any_mod(mods) {
        // 带 mods → CSI 参数化(即使 app_cursor)。
        format!("\x1b[1;{}{}", mod_param(mods), letter).into_bytes()
    } else if modes.app_cursor {
        format!("\x1bO{}", letter).into_bytes()
    } else {
        format!("\x1b[{}", letter).into_bytes()
    }
}

/// `~` 终结族:Insert(2)、Delete(3)、PageUp(5)、PageDown(6)。
fn tilde_key(code: u8, mods: &Modifiers) -> Vec<u8> {
    if has_any_mod(mods) {
        format!("\x1b[{};{}~", code, mod_param(mods)).into_bytes()
    } else {
        format!("\x1b[{}~", code).into_bytes()
    }
}

fn encode_function_key(n: u8, mods: &Modifiers) -> Vec<u8> {
    // F1-F4 默认 SS3,带 mods 时回退 CSI 参数化。F5+ 默认 ~ 终结族。
    // `n` 由 `FunctionKey` 在边界保证 1..=12,所以这里 unreachable 不是兜底
    // 而是把不变量声明出来 ── 进得来就一定合法。
    let has_mods = has_any_mod(mods);
    match n {
        1..=4 => {
            let letter = match n {
                1 => 'P',
                2 => 'Q',
                3 => 'R',
                4 => 'S',
                _ => unreachable!(),
            };
            if has_mods {
                format!("\x1b[1;{}{}", mod_param(mods), letter).into_bytes()
            } else {
                format!("\x1bO{}", letter).into_bytes()
            }
        }
        5..=12 => {
            // F5..F12 → 15, 17, 18, 19, 20, 21, 23, 24(F6 没跳 16,F11 跳 22)
            let code: u8 = match n {
                5 => 15,
                6 => 17,
                7 => 18,
                8 => 19,
                9 => 20,
                10 => 21,
                11 => 23,
                12 => 24,
                _ => unreachable!(),
            };
            if has_mods {
                format!("\x1b[{};{}~", code, mod_param(mods)).into_bytes()
            } else {
                format!("\x1b[{}~", code).into_bytes()
            }
        }
        _ => unreachable!("FunctionKey invariant: n is 1..=12"),
    }
}

fn has_any_mod(mods: &Modifiers) -> bool {
    mods.shift || mods.alt || mods.ctrl
}

/// DEC modifier 参数:`1 + shift + 2·alt + 4·ctrl`。
/// 无修饰 = 1;实际只有 `mod_param > 1` 时才会走 mod 形态。
fn mod_param(mods: &Modifiers) -> u8 {
    1 + u8::from(mods.shift) + 2 * u8::from(mods.alt) + 4 * u8::from(mods.ctrl)
}

// ───────────────────────── 粘贴 ─────────────────────────

/// 把粘贴文本编码成 PTY 字节。`bracketed_paste` 开启时包裹 + 防 injection。
pub fn encode_paste(text: &str, modes: &TerminalModes) -> Vec<u8> {
    if !modes.bracketed_paste {
        return text.as_bytes().to_vec();
    }
    // 防 paste injection:清掉嵌入的 \x1b[201~,这是 xterm 的做法。
    // 直接 String::replace 因为 \x1b[201~ 是纯 ASCII 子串,UTF-8 安全。
    let sanitized = text.replace("\x1b[201~", "");
    let mut out = Vec::with_capacity(sanitized.len() + 12);
    out.extend_from_slice(b"\x1b[200~");
    out.extend_from_slice(sanitized.as_bytes());
    out.extend_from_slice(b"\x1b[201~");
    out
}

// ───────────────────────── 鼠标 ─────────────────────────

/// 把鼠标事件编码成 PTY 字节。返回 `None` 表示**不上报**。
pub fn encode_mouse(event: &MouseEvent, modes: &TerminalModes) -> Option<Vec<u8>> {
    // mouse_reporting = Off 一切不报。
    if matches!(modes.mouse_reporting, MouseReporting::Off) {
        return None;
    }

    // mode 过滤:Drag 要求 Button/Any;Motion 要求 Any。
    match event.kind {
        MouseEventKind::Drag { .. } => {
            if matches!(modes.mouse_reporting, MouseReporting::Normal) {
                return None;
            }
        }
        MouseEventKind::Motion => {
            if !matches!(modes.mouse_reporting, MouseReporting::Any) {
                return None;
            }
        }
        _ => {}
    }

    // 基础 button code + 修饰符 OR。SGR 保留原 code,终结字符区分 M/m。
    // X10 release 走「低两位置 3、保留修饰键和 motion 位」── 直接 OR 0b11。
    let (button_code, is_release) = button_code(event.kind, &event.mods);
    let col = event.col.get();
    let row = event.row.get();

    if modes.sgr_mouse {
        // SGR:\x1b[<button;col;row;M  /  ...m
        let terminator = if is_release { 'm' } else { 'M' };
        Some(format!("\x1b[<{};{};{}{}", button_code, col, row, terminator).into_bytes())
    } else {
        // X10:\x1b[M + 3 个 byte,数值偏移 32。单字节上限 col/row ≤ 223。
        // 超出范围 X10 协议无法表达,返回 None ── 谎报坐标比丢事件更糟。
        // 现代终端会自己开 SGR(?1006)避免这个限制。
        if col > 223 || row > 223 {
            return None;
        }
        let final_code = if is_release {
            // 低两位 = 0b11 表示 release,修饰键 / motion 位保留。
            button_code | 0b11
        } else {
            button_code
        };
        let b1 = final_code + 32;
        let b2 = (col + 32) as u8;
        let b3 = (row + 32) as u8;
        Some(vec![0x1b, b'[', b'M', b1, b2, b3])
    }
}

/// 返回 `(button_code, is_release)`。
fn button_code(kind: MouseEventKind, mods: &Modifiers) -> (u8, bool) {
    let (base, is_release) = match kind {
        MouseEventKind::Press { button } => (button_base(button), false),
        MouseEventKind::Release { button } => (button_base(button), true),
        MouseEventKind::Drag { button } => (button_base(button) | 32, false),
        // Motion 报「无按键 motion」:base 用 3(对应 X10 的「release/motion」位),
        // 加 motion bit 32。SGR 也用这个 35。
        MouseEventKind::Motion => (3 | 32, false),
        MouseEventKind::WheelUp => (64, false),
        MouseEventKind::WheelDown => (65, false),
    };
    let with_mods = base
        | (if mods.shift { 4 } else { 0 })
        | (if mods.alt { 8 } else { 0 })
        | (if mods.ctrl { 16 } else { 0 });
    (with_mods, is_release)
}

fn button_base(button: MouseButton) -> u8 {
    match button {
        MouseButton::Left => 0,
        MouseButton::Middle => 1,
        MouseButton::Right => 2,
    }
}

// ───────────────────────── 焦点 ─────────────────────────

/// 把窗口焦点事件编码成 PTY 字节。`focus_reporting` 关时返回 `None`。
pub fn encode_focus(gained: bool, modes: &TerminalModes) -> Option<Vec<u8>> {
    if !modes.focus_reporting {
        return None;
    }
    Some(if gained {
        b"\x1b[I".to_vec()
    } else {
        b"\x1b[O".to_vec()
    })
}
