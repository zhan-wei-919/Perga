//! Input Encoder:语义输入事件 + `TerminalModes` → PTY 字节。
//!
//! 和 [`terminal-protocol`](../terminal_protocol/index.html) 对称 ── 一个出
//! (grid 状态 → 前端)、一个入(前端 → PTY)。都消费
//! [`terminal_engine::TerminalModes`],都是纯函数,都不做 IO。
//!
//! # 谁负责什么
//!
//! - **前端**:浏览器 DOM 事件归一化(`KeyboardEvent` → [`KeyEvent`]、
//!   `MouseEvent` → [`MouseEvent`]、`focus`/`blur` → bool),处理 OS / 布局
//!   差异和 IME composition。
//! - **本 crate**:纯函数,根据当前 [`TerminalModes`] 决定字节形态。
//! - **上层 Session**:拿 [`encode_key`] / [`encode_paste`] / [`encode_mouse`]
//!   / [`encode_focus`] 的返回值通过 `PtyCommand::Write` 灌进 PTY。
//!
//! # 协议契约要点
//!
//! - 箭头 / Home / End 在 `app_cursor` 下走 SS3(`\x1bO_`),否则 CSI(`\x1b[_`);
//!   **带修饰符时回退 CSI 参数化**(SS3 + DEC param 不标准)。
//! - 粘贴在 `bracketed_paste` 下用 `\x1b[200~ ... \x1b[201~` 包裹,且**清掉**
//!   嵌入的 `\x1b[201~` 防 paste injection。
//! - 鼠标:`mouse_reporting` 决定上报与否、`sgr_mouse` 决定 SGR vs X10 字节
//!   编码。Off 时返回 `None`,前端自己做选择 / 复制。
//! - 焦点:`focus_reporting` 关时 [`encode_focus`] 返回 `None`。
//!
//! [`TerminalModes`]: terminal_engine::TerminalModes

mod encoder;
mod event;

pub use encoder::{encode_focus, encode_key, encode_mouse, encode_paste};
pub use event::{FunctionKey, Key, KeyEvent, Modifiers, MouseButton, MouseEvent, MouseEventKind};
