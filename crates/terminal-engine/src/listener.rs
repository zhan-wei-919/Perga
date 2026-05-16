//! `alacritty_terminal::Term<T>` 的 `EventListener` 回调实现。
//!
//! `Term` 用 listener 告诉外面「请把这些字节写回 PTY」「窗口标题改了」
//! 等副作用。我们的 listener 持一份 `Arc<Mutex<ListenerState>>`,捕获感
//! 兴趣的事件;`TerminalEngine` 自己也持同一个 Arc,需要时读 / drain。
//!
//! 必须接住 `Event::PtyWrite`,否则 `\x1b[6n`(CPR)、`\x1b[c`(DA)
//! 之类的能力查询不会回包,vim / less 会卡在等响应上。

use std::collections::VecDeque;
use std::sync::Arc;

use alacritty_terminal::event::{Event, EventListener};
use parking_lot::Mutex;

#[derive(Default)]
pub(crate) struct ListenerState {
    /// 终端要写回 PTY 的字节。调用方靠 `TerminalEngine::drain_pending_writes`
    /// 取走再写回 PTY。
    pub(crate) pending_writes: VecDeque<Vec<u8>>,
    /// OSC 0/2 设置的窗口标题;`ResetTitle` 会清回 None。
    pub(crate) title: Option<String>,
    /// `Event::Bell` 累计计数。第一刀只记数,不向外暴露 —— 后续需要时再加 API。
    pub(crate) bells: u32,
}

#[derive(Clone)]
pub(crate) struct CaptureListener {
    state: Arc<Mutex<ListenerState>>,
}

impl CaptureListener {
    pub(crate) fn new(state: Arc<Mutex<ListenerState>>) -> Self {
        Self { state }
    }
}

impl EventListener for CaptureListener {
    fn send_event(&self, event: Event) {
        let mut s = self.state.lock();
        match event {
            Event::PtyWrite(text) => s.pending_writes.push_back(text.into_bytes()),
            Event::Title(t) => s.title = Some(t),
            Event::ResetTitle => s.title = None,
            Event::Bell => s.bells = s.bells.saturating_add(1),
            // 显式忽略:Clipboard{Store,Load}、ColorRequest、TextAreaSizeRequest、
            // CursorBlinkingChange、MouseCursorDirty、Wakeup、Exit、ChildExit。
            // 它们要么需要外部状态(剪贴板 / 颜色表)我们目前没接,要么是 UI
            // hint(blink、dirty)在 sync 适配层没意义。
            _ => {}
        }
    }
}
