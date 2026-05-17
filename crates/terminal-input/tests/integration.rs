//! `terminal-input` byte-level 集成测试。
//!
//! 每个测试用合成 `KeyEvent` / `MouseEvent` + 三档 `TerminalModes` 做断言,
//! 锁住 xterm baseline 的精确字节输出。

use std::num::NonZeroU16;

use terminal_engine::{MouseReporting, TerminalModes};
use terminal_input::{
    encode_focus, encode_key, encode_mouse, encode_paste, FunctionKey, Key, KeyEvent, Modifiers,
    MouseButton, MouseEvent, MouseEventKind,
};

// ───────────────────────── helpers ─────────────────────────

fn modes_default() -> TerminalModes {
    TerminalModes {
        alt_screen: false,
        app_cursor: false,
        bracketed_paste: false,
        mouse_reporting: MouseReporting::Off,
        sgr_mouse: false,
        focus_reporting: false,
    }
}

fn ke(key: Key) -> KeyEvent {
    KeyEvent {
        key,
        mods: Modifiers::default(),
    }
}

fn ke_mods(key: Key, mods: Modifiers) -> KeyEvent {
    KeyEvent { key, mods }
}

fn ch(c: char) -> Key {
    Key::Char { value: c }
}

fn mods(ctrl: bool, alt: bool, shift: bool) -> Modifiers {
    Modifiers { ctrl, alt, shift }
}

fn nz(v: u16) -> NonZeroU16 {
    NonZeroU16::new(v).expect("test col/row must be non-zero")
}

fn me(kind: MouseEventKind, col: u16, row: u16) -> MouseEvent {
    MouseEvent {
        kind,
        col: nz(col),
        row: nz(row),
        mods: Modifiers::default(),
    }
}

fn fk(n: u8) -> Key {
    Key::F {
        n: FunctionKey::new(n).expect("test F key must be 1..=12"),
    }
}

// ───────────────────────── Char 系列 ─────────────────────────

#[test]
fn plain_ascii_char() {
    assert_eq!(encode_key(&ke(ch('a')), &modes_default()), b"a");
}

#[test]
fn utf8_char() {
    // '中' = U+4E2D = 3-byte UTF-8 E4 B8 AD
    assert_eq!(
        encode_key(&ke(ch('中')), &modes_default()),
        vec![0xE4, 0xB8, 0xAD]
    );
}

#[test]
fn ctrl_letter_lowercase() {
    let m = mods(true, false, false);
    assert_eq!(
        encode_key(&ke_mods(ch('a'), m), &modes_default()),
        vec![0x01]
    );
    assert_eq!(
        encode_key(&ke_mods(ch('z'), m), &modes_default()),
        vec![0x1A]
    );
}

#[test]
fn ctrl_letter_uppercase_same() {
    let m = mods(true, false, false);
    assert_eq!(
        encode_key(&ke_mods(ch('A'), m), &modes_default()),
        vec![0x01]
    );
}

#[test]
fn ctrl_bracket_family() {
    let m = mods(true, false, false);
    assert_eq!(
        encode_key(&ke_mods(ch('['), m), &modes_default()),
        vec![0x1B]
    );
    assert_eq!(
        encode_key(&ke_mods(ch('\\'), m), &modes_default()),
        vec![0x1C]
    );
    assert_eq!(
        encode_key(&ke_mods(ch(']'), m), &modes_default()),
        vec![0x1D]
    );
    assert_eq!(
        encode_key(&ke_mods(ch('^'), m), &modes_default()),
        vec![0x1E]
    );
    assert_eq!(
        encode_key(&ke_mods(ch('_'), m), &modes_default()),
        vec![0x1F]
    );
}

#[test]
fn ctrl_at_and_space() {
    let m = mods(true, false, false);
    assert_eq!(
        encode_key(&ke_mods(ch('@'), m), &modes_default()),
        vec![0x00]
    );
    assert_eq!(
        encode_key(&ke_mods(ch(' '), m), &modes_default()),
        vec![0x00]
    );
}

#[test]
fn alt_letter_prefixes_esc() {
    let m = mods(false, true, false);
    assert_eq!(encode_key(&ke_mods(ch('a'), m), &modes_default()), b"\x1ba");
}

#[test]
fn ctrl_alt_letter() {
    let m = mods(true, true, false);
    // ESC + Ctrl+a → \x1b \x01
    assert_eq!(
        encode_key(&ke_mods(ch('a'), m), &modes_default()),
        vec![0x1b, 0x01]
    );
}

// ───────────────────────── 特殊键 ─────────────────────────

#[test]
fn enter_tab_backspace_escape() {
    let d = modes_default();
    assert_eq!(encode_key(&ke(Key::Enter), &d), b"\r");
    assert_eq!(encode_key(&ke(Key::Tab), &d), b"\t");
    assert_eq!(encode_key(&ke(Key::Backspace), &d), vec![0x7f]);
    assert_eq!(encode_key(&ke(Key::Escape), &d), vec![0x1b]);
}

#[test]
fn shift_tab() {
    let m = mods(false, false, true);
    assert_eq!(
        encode_key(&ke_mods(Key::Tab, m), &modes_default()),
        b"\x1b[Z"
    );
}

// ───────────────────────── 箭头 / Home / End ─────────────────────────

#[test]
fn arrows_default() {
    let d = modes_default();
    assert_eq!(encode_key(&ke(Key::Up), &d), b"\x1b[A");
    assert_eq!(encode_key(&ke(Key::Down), &d), b"\x1b[B");
    assert_eq!(encode_key(&ke(Key::Right), &d), b"\x1b[C");
    assert_eq!(encode_key(&ke(Key::Left), &d), b"\x1b[D");
}

#[test]
fn arrows_app_cursor() {
    let mut m = modes_default();
    m.app_cursor = true;
    assert_eq!(encode_key(&ke(Key::Up), &m), b"\x1bOA");
    assert_eq!(encode_key(&ke(Key::Down), &m), b"\x1bOB");
    assert_eq!(encode_key(&ke(Key::Right), &m), b"\x1bOC");
    assert_eq!(encode_key(&ke(Key::Left), &m), b"\x1bOD");
}

#[test]
fn arrow_with_ctrl_uses_csi_even_in_app_cursor() {
    let mut m = modes_default();
    m.app_cursor = true;
    let ctrl = mods(true, false, false);
    // Ctrl+↑ → CSI 参数化(P=5),即使 app_cursor 也走 CSI
    assert_eq!(encode_key(&ke_mods(Key::Up, ctrl), &m), b"\x1b[1;5A");
}

#[test]
fn home_end_default_and_app_cursor() {
    let d = modes_default();
    assert_eq!(encode_key(&ke(Key::Home), &d), b"\x1b[H");
    assert_eq!(encode_key(&ke(Key::End), &d), b"\x1b[F");
    let mut m = modes_default();
    m.app_cursor = true;
    assert_eq!(encode_key(&ke(Key::Home), &m), b"\x1bOH");
    assert_eq!(encode_key(&ke(Key::End), &m), b"\x1bOF");
}

#[test]
fn arrow_modifier_param_table() {
    let d = modes_default();
    // shift=2, alt=3, shift+alt=4, ctrl=5, shift+ctrl=6, alt+ctrl=7, all=8
    let cases = [
        (mods(false, false, true), 2),
        (mods(false, true, false), 3),
        (mods(false, true, true), 4),
        (mods(true, false, false), 5),
        (mods(true, false, true), 6),
        (mods(true, true, false), 7),
        (mods(true, true, true), 8),
    ];
    for (m, p) in cases {
        let out = encode_key(&ke_mods(Key::Up, m), &d);
        let want = format!("\x1b[1;{}A", p);
        assert_eq!(out, want.as_bytes(), "mods={:?} expected P={p}", m);
    }
}

// ───────────────────────── 编辑 / 翻页 ─────────────────────────

#[test]
fn insert_delete_pageup_pagedown_baseline() {
    let d = modes_default();
    assert_eq!(encode_key(&ke(Key::Insert), &d), b"\x1b[2~");
    assert_eq!(encode_key(&ke(Key::Delete), &d), b"\x1b[3~");
    assert_eq!(encode_key(&ke(Key::PageUp), &d), b"\x1b[5~");
    assert_eq!(encode_key(&ke(Key::PageDown), &d), b"\x1b[6~");
}

#[test]
fn insert_with_shift() {
    let m = mods(false, false, true);
    assert_eq!(
        encode_key(&ke_mods(Key::Insert, m), &modes_default()),
        b"\x1b[2;2~"
    );
}

// ───────────────────────── 功能键 ─────────────────────────

#[test]
fn f1_f4_ss3_baseline() {
    let d = modes_default();
    assert_eq!(encode_key(&ke(fk(1)), &d), b"\x1bOP");
    assert_eq!(encode_key(&ke(fk(2)), &d), b"\x1bOQ");
    assert_eq!(encode_key(&ke(fk(3)), &d), b"\x1bOR");
    assert_eq!(encode_key(&ke(fk(4)), &d), b"\x1bOS");
}

#[test]
fn f5_to_f12_baseline() {
    let d = modes_default();
    let cases = [
        (5u8, "15"),
        (6, "17"),
        (7, "18"),
        (8, "19"),
        (9, "20"),
        (10, "21"),
        (11, "23"),
        (12, "24"),
    ];
    for (n, code) in cases {
        let out = encode_key(&ke(fk(n)), &d);
        let want = format!("\x1b[{}~", code);
        assert_eq!(out, want.as_bytes(), "F{n}");
    }
}

#[test]
fn f1_with_shift_uses_csi() {
    let m = mods(false, false, true);
    assert_eq!(
        encode_key(&ke_mods(fk(1), m), &modes_default()),
        b"\x1b[1;2P"
    );
}

#[test]
fn f5_with_ctrl() {
    let m = mods(true, false, false);
    assert_eq!(
        encode_key(&ke_mods(fk(5), m), &modes_default()),
        b"\x1b[15;5~"
    );
}

#[test]
fn function_key_constructor_rejects_out_of_range() {
    // 边界拦截:0 / 13 / 255 都不能构造出 FunctionKey,Encoder 不再需要兜底分支。
    assert!(FunctionKey::new(0).is_none());
    assert!(FunctionKey::new(13).is_none());
    assert!(FunctionKey::new(u8::MAX).is_none());
    assert_eq!(FunctionKey::new(1).map(|f| f.get()), Some(1));
    assert_eq!(FunctionKey::new(12).map(|f| f.get()), Some(12));
}

// ───────────────────────── 粘贴 ─────────────────────────

#[test]
fn paste_raw_when_bracketed_off() {
    let d = modes_default();
    assert_eq!(encode_paste("hello\nworld", &d), b"hello\nworld");
}

#[test]
fn paste_bracketed_wraps() {
    let mut m = modes_default();
    m.bracketed_paste = true;
    assert_eq!(encode_paste("hello", &m), b"\x1b[200~hello\x1b[201~");
}

#[test]
fn paste_sanitizes_embedded_terminator() {
    let mut m = modes_default();
    m.bracketed_paste = true;
    // 输入夹了一个伪造的结束 marker,必须移除,否则攻击者能逃出 paste mode。
    let attack = "good\x1b[201~rm -rf /";
    let out = encode_paste(attack, &m);
    let s = String::from_utf8(out).expect("ascii");
    assert_eq!(s, "\x1b[200~goodrm -rf /\x1b[201~");
}

// ───────────────────────── 鼠标 ─────────────────────────

#[test]
fn mouse_off_returns_none() {
    let m = modes_default(); // mouse_reporting = Off
    let press = me(
        MouseEventKind::Press {
            button: MouseButton::Left,
        },
        10,
        5,
    );
    assert!(encode_mouse(&press, &m).is_none());
    let motion = me(MouseEventKind::Motion, 1, 1);
    assert!(encode_mouse(&motion, &m).is_none());
}

#[test]
fn mouse_normal_press_x10() {
    let mut m = modes_default();
    m.mouse_reporting = MouseReporting::Normal;
    let press = me(
        MouseEventKind::Press {
            button: MouseButton::Left,
        },
        10,
        5,
    );
    // button=0, +32=' ' (0x20); col=10+32=42='*'; row=5+32=37='%'
    assert_eq!(
        encode_mouse(&press, &m).expect("Normal press"),
        vec![0x1b, b'[', b'M', 0x20, b'*', b'%']
    );
}

#[test]
fn mouse_normal_filters_drag_and_motion() {
    let mut m = modes_default();
    m.mouse_reporting = MouseReporting::Normal;
    let drag = me(
        MouseEventKind::Drag {
            button: MouseButton::Left,
        },
        10,
        5,
    );
    assert!(encode_mouse(&drag, &m).is_none());
    let motion = me(MouseEventKind::Motion, 10, 5);
    assert!(encode_mouse(&motion, &m).is_none());
}

#[test]
fn mouse_button_reports_drag_not_motion() {
    let mut m = modes_default();
    m.mouse_reporting = MouseReporting::Button;
    let drag = me(
        MouseEventKind::Drag {
            button: MouseButton::Left,
        },
        10,
        5,
    );
    assert!(encode_mouse(&drag, &m).is_some());
    let motion = me(MouseEventKind::Motion, 10, 5);
    assert!(encode_mouse(&motion, &m).is_none());
}

#[test]
fn mouse_any_reports_motion() {
    let mut m = modes_default();
    m.mouse_reporting = MouseReporting::Any;
    let motion = me(MouseEventKind::Motion, 10, 5);
    assert!(encode_mouse(&motion, &m).is_some());
}

#[test]
fn mouse_sgr_press_release() {
    let mut m = modes_default();
    m.mouse_reporting = MouseReporting::Normal;
    m.sgr_mouse = true;
    let press = me(
        MouseEventKind::Press {
            button: MouseButton::Left,
        },
        10,
        5,
    );
    assert_eq!(
        encode_mouse(&press, &m).expect("press"),
        b"\x1b[<0;10;5M".to_vec()
    );
    let release = me(
        MouseEventKind::Release {
            button: MouseButton::Left,
        },
        10,
        5,
    );
    assert_eq!(
        encode_mouse(&release, &m).expect("release"),
        b"\x1b[<0;10;5m".to_vec()
    );
}

#[test]
fn mouse_sgr_with_modifiers() {
    let mut m = modes_default();
    m.mouse_reporting = MouseReporting::Normal;
    m.sgr_mouse = true;
    let press = MouseEvent {
        kind: MouseEventKind::Press {
            button: MouseButton::Left,
        },
        col: nz(10),
        row: nz(5),
        mods: Modifiers {
            ctrl: true,
            alt: false,
            shift: true,
        },
    };
    // button=0 | shift(4) | ctrl(16) = 20
    assert_eq!(
        encode_mouse(&press, &m).expect("press"),
        b"\x1b[<20;10;5M".to_vec()
    );
}

#[test]
fn mouse_wheel_up_sgr() {
    let mut m = modes_default();
    m.mouse_reporting = MouseReporting::Normal;
    m.sgr_mouse = true;
    let wheel = me(MouseEventKind::WheelUp, 1, 1);
    assert_eq!(
        encode_mouse(&wheel, &m).expect("wheel"),
        b"\x1b[<64;1;1M".to_vec()
    );
}

#[test]
fn mouse_x10_overflow_returns_none() {
    let mut m = modes_default();
    m.mouse_reporting = MouseReporting::Normal;
    // SGR off,X10 单字节坐标只能表达 col/row ≤ 223。超出返回 None ──
    // 不能用截断坐标谎报点击位置。前端应该开 SGR(?1006)避免限制。
    let too_wide = me(
        MouseEventKind::Press {
            button: MouseButton::Left,
        },
        224,
        5,
    );
    assert!(encode_mouse(&too_wide, &m).is_none());
    let too_tall = me(
        MouseEventKind::Press {
            button: MouseButton::Left,
        },
        5,
        224,
    );
    assert!(encode_mouse(&too_tall, &m).is_none());
    // 边界 ≤ 223 仍然上报。
    let on_edge = me(
        MouseEventKind::Press {
            button: MouseButton::Left,
        },
        223,
        223,
    );
    assert_eq!(
        encode_mouse(&on_edge, &m).expect("on edge"),
        vec![0x1b, b'[', b'M', 0x20, 255, 255]
    );
}

#[test]
fn mouse_x10_release_preserves_modifiers() {
    let mut m = modes_default();
    m.mouse_reporting = MouseReporting::Normal;
    // Shift+Ctrl+Left release。xterm normal tracking 协议:release 把低两位
    // 置为 0b11 = 3,但 shift(4)/ctrl(16)/motion(32) 必须保留。
    // 之前 final_code 直接重写成 3,把修饰键抹掉,Shift/Ctrl-click release
    // 在 X10 模式下会上报成普通 release。
    let release = MouseEvent {
        kind: MouseEventKind::Release {
            button: MouseButton::Left,
        },
        col: nz(10),
        row: nz(5),
        mods: Modifiers {
            ctrl: true,
            alt: false,
            shift: true,
        },
    };
    // button base=0 | shift(4) | ctrl(16) = 20;release 低两位 → 3 ⇒ 23。
    // +32 = 55 = '7'。
    let out = encode_mouse(&release, &m).expect("release with mods");
    assert_eq!(out, vec![0x1b, b'[', b'M', 55, b'*', b'%']);
}

// ───────────────────────── 焦点 ─────────────────────────

#[test]
fn focus_off_returns_none() {
    let m = modes_default(); // focus_reporting = false
    assert!(encode_focus(true, &m).is_none());
    assert!(encode_focus(false, &m).is_none());
}

#[test]
fn focus_gained() {
    let mut m = modes_default();
    m.focus_reporting = true;
    assert_eq!(encode_focus(true, &m).expect("gained"), b"\x1b[I");
}

#[test]
fn focus_lost() {
    let mut m = modes_default();
    m.focus_reporting = true;
    assert_eq!(encode_focus(false, &m).expect("lost"), b"\x1b[O");
}
